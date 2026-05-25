import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("search CLI", () => {
  test("search exits 1 when the query is empty", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(["search", "", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing required field: query");
  });

  test("search prints QMD results as tab-separated lines", async () => {
    const fixture = await createSearchFixture("wiki-v2");
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([
        { path: join(fixture.projectPath, "prds", "PRD-001.md"), score: 0.9, snippet: "First\nresult" },
        { path: join(fixture.projectPath, "slices", "SLICE-001.md"), score: 0.72, snippet: "Second result" },
      ]),
    );

    const result = await runWiki(["search", "vault", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `${join(fixture.projectPath, "prds", "PRD-001.md")}\t0.9\tFirst result\n` +
        `${join(fixture.projectPath, "slices", "SLICE-001.md")}\t0.72\tSecond result\n`,
    );
    expect(result.stderr).toBe("");
    expect(await readFile(fixture.stateFile, "utf8")).toBe(
      `collection list\ncollection add wiki-v2 ${fixture.projectPath} **/*.md\nquery vault --json --collection wiki-v2\n`,
    );
  });
});

type SearchFixture = {
  vaultRoot: string;
  projectPath: string;
  stateFile: string;
  resultsFile: string;
  env: Record<string, string>;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], fixture: SearchFixture): Promise<CommandResult> {
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

async function createSearchFixture(project: string): Promise<SearchFixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-search-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "decisions"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(join(projectPath, "_project.md"), "---\nrepo: /tmp/repo\ntest_command: bun test\n---\n");

  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const resultsFile = join(root, "qmd-results.json");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(resultsFile, "[]");
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
