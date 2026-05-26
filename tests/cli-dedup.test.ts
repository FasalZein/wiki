import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pre-write dedup gate", () => {
  test("decision create proceeds when QMD returns no high-score match", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("DECISION-0001\n");
    expect(await readFile(fixture.stateFile, "utf8")).toContain(
      "query Use SQLite Need a durable local index. Use SQLite for local persistence. --json --collection wiki-v2\n",
    );
  });

  test("prd create blocks on a match at the weak threshold and writes nothing", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.7, snippet: "Same feature" }]),
    );

    const result = await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("possible duplicate artifacts found");
    expect(result.stderr).toContain("PRD-0007.md");
    expect(result.stderr).toContain("score: 0.7");
    expect(await readdir(join(fixture.projectPath, "prds"))).toEqual([]);
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
        "prd",
        "create",
        "--title",
        "Core wiki CLI",
        "--project",
        "wiki-v2",
        "--force-new",
        "This is intentionally different from the existing PRD",
      ],
      fixture,
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.projectPath, "prds", "PRD-0001.md"), "utf8")).toContain(
      "force_new_reason: This is intentionally different from the existing PRD",
    );
  });

  test("short force-new reason exits 1 and writes nothing", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(
      ["decision", "create", ...decisionArgs().slice(2), "--force-new", "too short"],
      fixture,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("force-new reason must be at least 30 characters");
    expect(await readdir(join(fixture.projectPath, "adrs"))).toEqual([]);
  });

  test("related-to bypasses the gate and records the link", async () => {
    const fixture = await createDedupFixture("wiki-v2");

    const result = await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", "wiki-v2", "--related-to", "PRD-0007"], fixture);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.projectPath, "prds", "PRD-0001.md"), "utf8")).toContain("related:\n  - PRD-0007");
  });

  test("supersedes bypasses the gate and updates the old same-type artifact", async () => {
    const fixture = await createDedupFixture("wiki-v2");
    await runWiki(["prd", "create", "--title", "Old wiki CLI", "--project", "wiki-v2", "--force-new", "Seeding old PRD without checking duplicates"], fixture);

    const result = await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", "wiki-v2", "--supersedes", "PRD-0001"], fixture);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.projectPath, "prds", "PRD-0002.md"), "utf8")).toContain("supersedes: PRD-0001");
    const old = await readFile(join(fixture.projectPath, "prds", "PRD-0001.md"), "utf8");
    expect(old).toContain("status: superseded");
    expect(old).toContain("superseded_by: PRD-0002");
  });

  test("handover create and plan create do not call QMD", async () => {
    const fixture = await createDedupFixture("wiki-v2", { failQmd: true });
    const repo = await mkdtemp(join(tmpdir(), "wiki-repo-"));
    tempPaths.push(repo);

    const handover = await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "ad-hoc"], fixture);
    const plan = await runWiki(["plan", "create", "--project", "wiki-v2", "--title", "Draft plan", "--repo", repo], fixture);

    expect(handover.exitCode).toBe(0);
    expect(plan.exitCode).toBe(0);
    expect(await readFile(fixture.stateFile, "utf8")).toBe("");
  });
});

function decisionArgs(): string[] {
  return [
    "decision",
    "create",
    "--title",
    "Use SQLite",
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
  return ["slice", "create", "--title", "Build slice authoring", "--project", "wiki-v2", "--parent-prd", "PRD-0001"];
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
  failQmd?: boolean;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], fixture: DedupFixture): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh"), ...fixture.env },
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
  await mkdir(join(projectPath, "handovers"));

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
if [ "\${FAIL_QMD:-0}" = "1" ]; then
  echo "fake qmd should not have been called" >&2
  exit 9
fi
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
      FAIL_QMD: options.failQmd === true ? "1" : "0",
    },
  };
}

async function seedPrd(fixture: DedupFixture): Promise<void> {
  const result = await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", "wiki-v2", "--force-new", "Seeding parent PRD for the slice dedup test"], fixture);
  expect(result.exitCode).toBe(0);
  await writeFile(fixture.resultsFile, "[]");
}
