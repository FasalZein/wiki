import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SLICE-0126: every write fires a cheap incremental qmd keyword `update` for the
// project's collection (inside the per-project lock, in mintAndWrite) so a freshly
// created artifact is in the keyword index with no manual `wiki sync`. Vector
// `embed` stays owned by `wiki sync`; `wiki search` stays a pure read (PRD-0018).
//
// A logging fake qmd records every invocation; the assertions read that log.
// `decision` has dedup OFF, so its ONLY qmd touch is the write-path update —
// no dedup gate noise to disentangle.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Fixture = {
  vaultRoot: string;
  projectPath: string;
  stateFile: string;
  env: Record<string, string>;
};

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runWiki(args: string[], fixture: Fixture): Promise<CommandResult> {
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

async function makeFixture(project: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-write-update-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  for (const f of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(projectPath, f), { recursive: true });
  }
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: /tmp/repo\ntest_command: bun test\n---\n# ${project}\n`);

  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const resultsFile = join(root, "qmd-results.json");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(stateFile, "");
  await writeFile(resultsFile, "[]");
  await writeFile(registeredFile, "");
  // A logging fake: every call is appended to STATE_FILE. `collection list`
  // echoes the registered file (so search/ensureCollection see what `add` wrote);
  // `update`/`embed` are no-ops beyond the log line; `query` echoes results.
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list) [ -f "$REGISTERED_FILE" ] && cat "$REGISTERED_FILE" || true ;;
      add)
        shift 2
        while [ $# -gt 0 ]; do
          if [ "$1" = "--name" ]; then echo "$2 (qmd://$2/)" >> "$REGISTERED_FILE"; break; fi
          shift
        done
        ;;
    esac
    ;;
  query) cat "$RESULTS_FILE" ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);

  return {
    vaultRoot,
    projectPath,
    stateFile,
    env: {
      QMD_COMMAND: qmdCommand,
      STATE_FILE: stateFile,
      REGISTERED_FILE: registeredFile,
      RESULTS_FILE: resultsFile,
    },
  };
}

function decisionArgs(project: string): string[] {
  return [
    "create", "decision",
    "--title", "Use SQLite",
    "--summary", "Use SQLite for the local index.",
    "--context", "Need a durable local index.",
    "--decision", "Use SQLite for local persistence.",
    "--consequences", "Keep migrations small and explicit.",
    "--project", project,
  ];
}

describe("SLICE-0126: incremental keyword index update on every write", () => {
  test("create fires a keyword `update` for the project collection and never embeds", async () => {
    const fixture = await makeFixture("wiki-v2");

    const result = await runWiki(decisionArgs("wiki-v2"), fixture);
    expect(result.exitCode).toBe(0);

    const lines = (await readFile(fixture.stateFile, "utf8")).split("\n").filter((l) => l.length > 0);
    // The write path registered the collection and ran a keyword update for it.
    expect(lines.some((l) => l.startsWith("collection add") || l.includes("--name wiki-v2"))).toBe(true);
    expect(lines.some((l) => l.startsWith("update") && l.includes("-c wiki-v2"))).toBe(true);
    // Vector embed is owned by `wiki sync`; the write path must NOT embed.
    expect(lines.some((l) => l.startsWith("embed"))).toBe(false);
    // Keyword update only — no --pull (that is a sync concern).
    expect(lines.some((l) => l.startsWith("update") && l.includes("--pull"))).toBe(false);
  });

  test("a second create reindexes again (incremental, not one-shot)", async () => {
    const fixture = await makeFixture("wiki-v2");

    expect((await runWiki(decisionArgs("wiki-v2"), fixture)).exitCode).toBe(0);
    expect((await runWiki(decisionArgs("wiki-v2"), fixture)).exitCode).toBe(0);

    const updates = (await readFile(fixture.stateFile, "utf8"))
      .split("\n")
      .filter((l) => l.startsWith("update") && l.includes("-c wiki-v2"));
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  test("search stays a pure read — it never fires an update on the read path (PRD-0018)", async () => {
    const fixture = await makeFixture("wiki-v2");

    // Seed one artifact (this create legitimately updates the index)...
    expect((await runWiki(decisionArgs("wiki-v2"), fixture)).exitCode).toBe(0);
    // ...then clear the log so we observe ONLY the search invocation.
    await writeFile(fixture.stateFile, "");

    const search = await runWiki(["search", "sqlite", "--project", "wiki-v2"], fixture);
    expect(search.exitCode).toBe(0);

    const lines = (await readFile(fixture.stateFile, "utf8")).split("\n").filter((l) => l.length > 0);
    // PRD-0018: search lists membership and queries, but never updates/embeds.
    expect(lines.some((l) => l.startsWith("update"))).toBe(false);
    expect(lines.some((l) => l.startsWith("embed"))).toBe(false);
    expect(lines.some((l) => l.startsWith("collection list"))).toBe(true);
    expect(lines.some((l) => l.startsWith("query"))).toBe(true);
  });
});
