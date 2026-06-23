import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("advisory dedup", () => {
  test("decision create proceeds when QMD returns no high-score match", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ADR-0001\n");
    expect(await readFile(fixture.stateFile, "utf8")).toContain(
      "query Use SQLite Need a durable local index. Use SQLite for local persistence. Keep migrations small and explicit. --json --collection wiki-v2\n",
    );
  });

  test("create no longer nags to run wiki sync (SLICE-0064: lean delivery loop)", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("wiki sync");
  });

  test("prd create warns on a match but proceeds (advisory dedup)", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.7, snippet: "Same feature" }]),
    );

    const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("PRD-0001\n");
    expect(result.stderr).toContain("possible duplicate artifacts found");
    expect(result.stderr).toContain("advisory");
  });

  test("slice create honors a custom weak threshold", async () => {
    const fixture = await createDedupFixture("wiki-v2", { projectFrontmatter: "dedup_threshold_weak: 0.8\n" });
    await seedPrd(fixture);
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([{ path: join(fixture.projectPath, "slices", "SLICE-0007.md"), score: 0.75, snippet: "Related slice" }]),
    );

    const result = await runWiki(sliceArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SLICE-0001\n");
  });

  test("force-new bypasses the gate and records the reason", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.95, snippet: "Same feature" }]),
    );

    const result = await runWiki(
      [
        "create",
        "prd",
        "--title",
        "Core wiki CLI",
        "--summary",
        "The core wiki CLI surface.",
        "--project",
        "wiki-v2",
        "--force-new",
        "This is intentionally different from the existing PRD",
      ],
      fixture,
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.projectPath, "prds", "PRD-0001-core-wiki-cli.md"), "utf8")).toContain(
      "force_new_reason: This is intentionally different from the existing PRD",
    );
  });

  test("short force-new reason exits 1 and writes nothing", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(
      ["create", "decision", ...decisionArgs().slice(2), "--force-new", "too short"],
      fixture,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("force-new reason must be at least 30 characters");
    expect(await readdir(join(fixture.projectPath, "adrs"))).toEqual([]);
  });

  test("related-to bypasses the gate and records the link", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2", "--related-to", "PRD-0007"], fixture);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.projectPath, "prds", "PRD-0001-core-wiki-cli.md"), "utf8")).toContain("related:\n  - PRD-0007");
  });

  test("supersedes bypasses the gate and updates the old same-type artifact", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await runWiki(["create", "prd", "--title", "Old wiki CLI", "--summary", "The old wiki CLI surface.", "--project", "wiki-v2", "--force-new", "Seeding old PRD without checking duplicates"], fixture);

    const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2", "--supersedes", "PRD-0001"], fixture);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.projectPath, "prds", "PRD-0002-core-wiki-cli.md"), "utf8")).toContain("supersedes: PRD-0001");
    const old = await readFile(join(fixture.projectPath, "prds", "PRD-0001-old-wiki-cli.md"), "utf8");
    expect(old).toContain("status: superseded");
    expect(old).toContain("superseded_by: PRD-0002");
  });

  test("a strong dedup match is advisory by default — create proceeds (memory-layer default)", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.95, snippet: "Same feature" }]),
    );

    const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("advisory");
    const prds = (await readdir(join(fixture.projectPath, "prds"))).filter((name) => name.startsWith("PRD-"));
    expect(prds.length).toBe(1);
  });

  test("a strong dedup match blocks create when dedup_strong_blocks is opt-in enabled (strict mode)", async () => {
    const fixture = await createDedupFixture("wiki-v2", { projectFrontmatter: "dedup_strong_blocks: true\n" });
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.95, snippet: "Same feature" }]),
    );

    const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to create");
    const prds = (await readdir(join(fixture.projectPath, "prds"))).filter((name) => name.startsWith("PRD-"));
    expect(prds.length).toBe(0);
  });

  test("slice supersedes marks the old slice superseded (P0.1 regression)", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await seedPrd(fixture);
    const first = await runWiki([...sliceArgs(), "--force-new", "Seeding the slice that will be superseded"], fixture);
    expect(first.exitCode).toBe(0);

    const result = await runWiki(["create", "slice", "--title", "Rebuild slice authoring", "--summary", "Rebuild the slice authoring flow.", "--project", "wiki-v2", "--parent-prd", "PRD-0001", "--supersedes", "SLICE-0001"], fixture);

    expect(result.exitCode).toBe(0);
    const sliceFiles = await readdir(join(fixture.projectPath, "slices"));
    const newSlice = await readFile(join(fixture.projectPath, "slices", sliceFiles.find((f) => f.startsWith("SLICE-0002"))!), "utf8");
    expect(newSlice).toContain("supersedes: SLICE-0001");
    const oldSlice = await readFile(join(fixture.projectPath, "slices", sliceFiles.find((f) => f.startsWith("SLICE-0001"))!), "utf8");
    expect(oldSlice).toContain("status: superseded");
    expect(oldSlice).toContain("superseded_by: SLICE-0002");
  });

  test("a post-write supersede failure leaves no orphan (P0.2 rollback)", async () => {
    // docs have no `superseded_by` field, so superseding one fails AFTER the new
    // doc is written — exercising the rollback that prevents orphan + id-gap.
    const fixture = await createDedupFixture("wiki-v2");
    await runWiki(["create", "doc", "--title", "Old reference doc", "--summary", "An old reference doc.", "--project", "wiki-v2", "--type", "reference", "--force-new", "Seeding a doc to attempt superseding"], fixture);

    const result = await runWiki(["create", "doc", "--title", "New reference doc", "--summary", "A new reference doc.", "--project", "wiki-v2", "--type", "reference", "--supersedes", "DOC-0001"], fixture);

    expect(result.exitCode).not.toBe(0);
    const remaining = await listMarkdownRecursive(join(fixture.projectPath, "docs"));
    expect(remaining.some((name) => name.startsWith("DOC-0002"))).toBe(false);
  });

  test("a bad --parent-prd aborts before superseding the old slice (P0.2 pre-flight)", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await seedPrd(fixture);
    const first = await runWiki([...sliceArgs(), "--force-new", "Seeding the slice that must stay un-superseded"], fixture);
    expect(first.exitCode).toBe(0);

    const result = await runWiki(["create", "slice", "--title", "Rebuild slice authoring", "--summary", "Rebuild the slice authoring flow.", "--project", "wiki-v2", "--parent-prd", "PRD-9999", "--supersedes", "SLICE-0001"], fixture);

    expect(result.exitCode).not.toBe(0);
    const sliceFiles = await readdir(join(fixture.projectPath, "slices"));
    expect(sliceFiles.some((name) => name.startsWith("SLICE-0002"))).toBe(false);
    const oldSlice = await readFile(join(fixture.projectPath, "slices", sliceFiles.find((f) => f.startsWith("SLICE-0001"))!), "utf8");
    expect(oldSlice).not.toContain("status: superseded");
    expect(oldSlice).not.toContain("superseded_by:");
  });
});

function decisionArgs(): string[] {
  return [
    "create",
    "decision",
    "--title",
    "Use SQLite",
    "--summary",
    "Use SQLite for the local index.",
    "--context",
    "Need a durable local index.",
    "--decision",
    "Use SQLite for local persistence.",
    "--consequences",
    "Keep migrations small and explicit.",
    "--project",
    "wiki-v2",
  ];
}

function sliceArgs(): string[] {
  return ["create", "slice", "--title", "Build slice authoring", "--summary", "Build the slice authoring flow.", "--project", "wiki-v2", "--parent-prd", "PRD-0001"];
}

type DedupFixture = {
  vaultRoot: string;
  projectPath: string;
  stateFile: string;
  resultsFile: string;
  env: Record<string, string>;
};

type DedupFixtureOptions = {
  projectFrontmatter?: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], fixture: DedupFixture): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, ...fixture.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function createDedupFixture(project: string, options: DedupFixtureOptions = {}): Promise<DedupFixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-dedup-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));

  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const resultsFile = join(root, "qmd-results.json");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(resultsFile, "[]");
  await writeFile(stateFile, "");
  await writeFile(
    join(projectPath, "_project.md"),
    `---\nrepo: /tmp/repo\ntest_command: bun test\n${options.projectFrontmatter ?? ""}---\n# ${project}\n`,
  );
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list)
        if [ -f "$REGISTERED_FILE" ]; then
          cat "$REGISTERED_FILE"
        fi
        ;;
      add)
        echo "$3" >> "$REGISTERED_FILE"
        ;;
    esac
    ;;
  query)
    cat "$RESULTS_FILE"
    ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);

  return {
    vaultRoot,
    projectPath,
    stateFile,
    resultsFile,
    env: {
      QMD_COMMAND: qmdCommand,
      STATE_FILE: stateFile,
      REGISTERED_FILE: registeredFile,
      RESULTS_FILE: resultsFile,
    },
  };
}

async function seedPrd(fixture: DedupFixture): Promise<void> {
  const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2", "--force-new", "Seeding parent PRD for the slice dedup test"], fixture);
  expect(result.exitCode).toBe(0);
  await writeFile(fixture.resultsFile, "[]");
}

async function listMarkdownRecursive(directory: string): Promise<string[]> {
  const names: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) names.push(...await listMarkdownRecursive(join(directory, entry.name)));
    else if (entry.isFile()) names.push(entry.name);
  }
  return names;
}
