import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression tests for the ADR-0044 fix batch (BUG-A..G, NOTE-0010): cheap
// validation precedes dedup (BUG-C), unknown flags rejected by name + `--body -`
// sentinel (BUG-D), same-kind-only dedup with title+summary query (BUG-B),
// stale-session dedup via a local same-kind scan (BUG-F), schema body sections +
// machine-owned split (BUG-E), and index.md excluded from results (search hygiene).

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Fixture = {
  vaultRoot: string;
  projectPath: string;
  resultsFile: string;
  env: Record<string, string>;
};

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runWiki(args: string[], fixture: Fixture, stdin?: string): Promise<CommandResult> {
  const repoRoot = import.meta.dir.replace(/\/tests$/, "");
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, ...fixture.env },
    stdin: stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function makeFixture(project = "wiki-v2", projectFrontmatter = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-adr0044-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  for (const dir of ["prds", "slices", "adrs", "handoffs"]) {
    await mkdir(join(projectPath, dir), { recursive: true });
  }
  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const resultsFile = join(root, "qmd-results.json");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(resultsFile, "[]");
  await writeFile(stateFile, "");
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: /tmp/repo\ntest_command: bun test\n${projectFrontmatter}---\n# ${project}\n`);
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list) [ -f "$REGISTERED_FILE" ] && cat "$REGISTERED_FILE" || true ;;
      add) echo "$3" >> "$REGISTERED_FILE" ;;
    esac ;;
  update) : ;;
  query) cat "$RESULTS_FILE" ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);
  return {
    vaultRoot,
    projectPath,
    resultsFile,
    env: { QMD_COMMAND: qmdCommand, STATE_FILE: stateFile, REGISTERED_FILE: registeredFile, RESULTS_FILE: resultsFile },
  };
}

function decisionArgs(overrides: string[] = []): string[] {
  return [
    "create", "decision",
    "--title", "Use SQLite",
    "--summary", "Use SQLite for the local index.",
    "--context", "Need a durable local index.",
    "--decision", "Use SQLite for local persistence.",
    "--consequences", "Keep migrations small and explicit.",
    "--project", "wiki-v2",
    ...overrides,
  ];
}

async function seedResults(fixture: Fixture, matches: Array<{ path: string; score: number }>): Promise<void> {
  await writeFile(fixture.resultsFile, JSON.stringify(matches.map((m) => ({ ...m, snippet: "x" }))));
}

describe("BUG-C: cheap validation precedes the dedup pass", () => {
  test("a create with BOTH a near-duplicate and an invalid field fails fast with only the validation error", async () => {
    const fixture = await makeFixture();
    // A strong same-kind qmd match is seeded — but the title is invalid (< 5 chars),
    // so validation must abort BEFORE any dedup advisory can print.
    await seedResults(fixture, [{ path: join(fixture.projectPath, "adrs", "ADR-0007.md"), score: 0.95 }]);

    const result = await runWiki(
      ["create", "decision", "--title", "abc", "--summary", "Use SQLite for the local index.",
        "--context", "c", "--decision", "d", "--consequences", "e", "--project", "wiki-v2"],
      fixture,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title: 3 chars, min 5 — add 2");
    expect(result.stderr).not.toContain("dedup:");
    expect(result.stderr).not.toContain("advisory");
    expect(result.stderr).not.toContain("proceeding with create");
    expect(await readdir(join(fixture.projectPath, "adrs"))).toEqual([]);
  });
});

describe("BUG-D: unknown flags rejected by name; --body - is never ambiguous", () => {
  test("an unknown flag errors naming the field per kind", async () => {
    const fixture = await makeFixture();
    const result = await runWiki(
      ["create", "decision", "--title", "Use SQLite here", "--summary", "Use SQLite for the local index.", "--project", "wiki-v2", "--tags", "x"],
      fixture,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("decision has no field: tags");
    expect(result.stderr).not.toContain("ambiguous");
  });

  test("the exact NOTE-0010 repro reports the unknown flag, not an ambiguous value", async () => {
    const fixture = await makeFixture();
    const result = await runWiki(
      ["create", "decision", "--title", "Right-edge decision", "--summary", "A decision about the right edge.",
        "--project", "wiki-v2", "--status", "accepted", "--tags", "rearchitecture", "--body", "-"],
      fixture,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("decision has no field: tags");
    expect(result.stderr).not.toContain("ambiguous");
  });

  test("`--body -` is a valid stdin sentinel and never trips the ambiguous parse", async () => {
    const fixture = await makeFixture();
    const body = "## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\ne\n";
    const result = await runWiki(
      ["create", "decision", "--title", "Use SQLite here", "--summary", "Use SQLite for the local index.", "--project", "wiki-v2", "--body", "-"],
      fixture,
      body,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("ambiguous");
    expect(result.stdout).toBe("ADR-0001\n");
  });
});

describe("BUG-B: dedup is same-kind only", () => {
  test("a cross-kind strong candidate never blocks or prompts — one info line only", async () => {
    const fixture = await makeFixture();
    await seedResults(fixture, [{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.92 }]);

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ADR-0001\n");
    expect(result.stderr).toContain("cross-kind, not a duplicate");
    expect(result.stderr).toContain("PRD-0007");
    expect(result.stderr).not.toContain("dedup:"); // no same-kind advisory
  });

  test("a cross-kind strong candidate does not block even in strict mode", async () => {
    const fixture = await makeFixture("wiki-v2", "dedup_strong_blocks: true\n");
    await seedResults(fixture, [{ path: join(fixture.projectPath, "prds", "PRD-0007.md"), score: 0.95 }]);

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ADR-0001\n");
    expect(result.stderr).not.toContain("refusing to create");
  });

  test("a same-kind strong candidate still gates in strict mode", async () => {
    const fixture = await makeFixture("wiki-v2", "dedup_strong_blocks: true\n");
    await seedResults(fixture, [{ path: join(fixture.projectPath, "adrs", "ADR-0007.md"), score: 0.95 }]);

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dedup: strong 0.95 vs ADR-0007");
    expect(result.stderr).toContain("refusing to create");
    expect(await readdir(join(fixture.projectPath, "adrs"))).toEqual([]);
  });
});

describe("BUG-F: dedup scans un-synced same-kind files", () => {
  test("a near-identical second create of the same kind flags the first, with no sync between", async () => {
    const fixture = await makeFixture();
    const first = await runWiki(decisionArgs(), fixture);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe("ADR-0001\n");

    // qmd still returns nothing (no sync ran); the local same-kind scan must catch ADR-0001.
    const second = await runWiki(decisionArgs(), fixture);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("ADR-0002\n");
    expect(second.stderr).toContain("dedup: strong");
    expect(second.stderr).toContain("vs ADR-0001");
  });
});

describe("search hygiene: index.md is excluded from dedup/search results", () => {
  test("a top-scoring index.md hit is dropped; a real same-kind hit still surfaces", async () => {
    const fixture = await makeFixture();
    await seedResults(fixture, [
      { path: join(fixture.projectPath, "index.md"), score: 0.99 },
      { path: join(fixture.projectPath, "adrs", "ADR-0007.md"), score: 0.9 },
    ]);

    const result = await runWiki(decisionArgs(), fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("index");
    expect(result.stderr).toContain("dedup: strong 0.90 vs ADR-0007");
  });
});

describe("BUG-E: wiki schema prints body sections + machine-owned split", () => {
  test("decision lists its authorable body sections", async () => {
    const fixture = await makeFixture();
    const result = await runWiki(["schema", "decision"], fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("body sections:");
    expect(result.stdout).toContain("## Context");
    expect(result.stdout).toContain("## Decision");
    expect(result.stdout).toContain("## Consequences");
  });

  test("a Content-style kind lists ## Content and shows its criteria", async () => {
    const fixture = await makeFixture();
    const result = await runWiki(["schema", "notes"], fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## Content");
    expect(result.stdout).toContain("criteria:");
  });

  test("handoff lists machine-owned sections separately and names the flag to use", async () => {
    const fixture = await makeFixture();
    const result = await runWiki(["schema", "handoff"], fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("machine-owned (do not author)");
    expect(result.stdout).toContain("## Decisions locked");
    expect(result.stdout).toContain("--decisions-made");
    expect(result.stdout).toContain("## What this session produced");
  });

  test("authoring a machine-owned section names the flag the author should use instead", async () => {
    const fixture = await makeFixture();
    const body = "## Decisions locked\n\n- [[ADR-0001]]\n";
    const result = await runWiki(
      ["create", "handoff", "--title", "Session handoff", "--summary", "A handoff for the session.",
        "--phase", "handoff", "--project", "wiki-v2", "--body", "-"],
      fixture,
      body,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("machine-owned");
    expect(result.stderr).toContain("--decisions-made");
  });
});
