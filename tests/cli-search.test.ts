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
    const log = await readFile(fixture.stateFile, "utf8");
    expect(log).toContain("collection list");
    expect(log).toContain(`collection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md`);
    expect(log).toContain("update -c wiki-v2");
    expect(log).toContain("query");
    expect(log).toContain("lex: vault");
  });

  test("search exits 0 with empty stdout when QMD returns no results", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(["search", "missing", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("search registers the project collection only once across repeated calls", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    expect((await runWiki(["search", "first", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);
    expect((await runWiki(["search", "second", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);

    const log = await readFile(fixture.stateFile, "utf8");
    // First call registers the collection, second call does not
    const addLines = log.split("\n").filter((line) => line.startsWith("collection add"));
    expect(addLines).toHaveLength(1);
    // Both calls run update (auto-refresh) and query
    const updateLines = log.split("\n").filter((line) => line.startsWith("update"));
    expect(updateLines).toHaveLength(2);
    expect(log).toContain("lex: first");
    expect(log).toContain("lex: second");
  });

  test("search include-research registers and queries both collections", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(["search", "vault", "--project", "wiki-v2", "--include-research"], fixture);

    expect(result.exitCode).toBe(0);
    const log = await readFile(fixture.stateFile, "utf8");
    expect(log).toContain(`collection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md`);
    expect(log).toContain(`collection add ${fixture.researchPath} --name research --mask **/*.md`);
    // Both collections get auto-refreshed
    expect(log).toContain("update -c wiki-v2");
    expect(log).toContain("update -c research");
    // Query includes both collections
    expect(log).toContain("--collection wiki-v2");
    expect(log).toContain("--collection research");
  });

  test("search type filter keeps only matching artifact folders", async () => {
    const fixture = await createSearchFixture("wiki-v2");
    // qmd emits "qmd://<collection>/<path>" URIs, not filesystem paths; the type
    // filter must read the artifact folder out of that URI.
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([
        { path: "qmd://wiki-v2/prds/PRD-001.md", score: 0.9, snippet: "PRD" },
        { path: "qmd://wiki-v2/slices/SLICE-001.md", score: 0.8, snippet: "Slice" },
      ]),
    );

    const result = await runWiki(["search", "vault", "--project", "wiki-v2", "--type", "slice"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("qmd://wiki-v2/slices/SLICE-001.md\t0.8\tSlice\n");
    // qmd truncates to a default 20-result window before we can filter by folder;
    // a --type filter must over-fetch so matching artifacts below that window survive.
    const log = await readFile(fixture.stateFile, "utf8");
    expect(log).toContain("-n 50");
  });

  test("search without a type filter does not over-fetch", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(["search", "vault", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    const log = await readFile(fixture.stateFile, "utf8");
    expect(log).not.toContain("-n ");
  });

  test("search exits 10 and surfaces qmd stderr when qmd fails", async () => {
    const fixture = await createSearchFixture("wiki-v2", { failQuery: true });

    const result = await runWiki(["search", "vault", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(10);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake qmd failed");
  });
});

type SearchFixture = {
  vaultRoot: string;
  projectPath: string;
  researchPath: string;
  stateFile: string;
  resultsFile: string;
  env: Record<string, string>;
};

type SearchFixtureOptions = {
  failQuery?: boolean;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], fixture: SearchFixture): Promise<CommandResult> {
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

async function createSearchFixture(project: string, options: SearchFixtureOptions = {}): Promise<SearchFixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-search-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
  await mkdir(join(projectPath, "docs"));
  const researchPath = join(root, "research");
  await mkdir(researchPath);
  await writeFile(
    join(projectPath, "_project.md"),
    `---\nrepo: /tmp/repo\ntest_command: bun test\nresearch_path: ${researchPath}\n---\n`,
  );

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
        # extract --name value from args
        shift 2
        while [ $# -gt 0 ]; do
          if [ "$1" = "--name" ]; then
            # mirror real qmd's "collection list" shape: "name (qmd://name/)"
            echo "$2 (qmd://$2/)" >> "$REGISTERED_FILE"
            break
          fi
          shift
        done
        ;;
    esac
    ;;
  query)
    if [ "\${FAIL_QUERY:-}" = "1" ]; then
      echo "fake qmd failed" >&2
      exit 7
    fi
    cat "$RESULTS_FILE"
    ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);

  return {
    vaultRoot,
    projectPath,
    researchPath,
    stateFile,
    resultsFile,
    env: {
      QMD_COMMAND: qmdCommand,
      STATE_FILE: stateFile,
      REGISTERED_FILE: registeredFile,
      RESULTS_FILE: resultsFile,
      FAIL_QUERY: options.failQuery === true ? "1" : "0",
    },
  };
}
