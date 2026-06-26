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

  test("search prints id/kind/title-enriched lines", async () => {
    const fixture = await createSearchFixture("wiki-v2");
    // Files don't exist on disk: id falls back to the filename, kind to the folder.
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
      `PRD-001\tprd\t\t0.9\tFirst result\n` +
        `SLICE-001\tslice\t\t0.72\tSecond result\n`,
    );
    expect(result.stderr).toContain("wiki vault:");
    const log = await readFile(fixture.stateFile, "utf8");
    expect(log).toContain("collection list");
    expect(log).toContain(`collection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md`);
    expect(log).toContain("update -c wiki-v2");
    expect(log).toContain("query");
    expect(log).toContain("lex: vault");
  });

  test("search prints a no-results line when QMD returns no results (SLICE-0092)", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(["search", "missing", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("no results\n");
    expect(result.stderr).toContain("wiki vault:");
  });

  test("search groups hits one line per artifact and enriches from frontmatter (SLICE-0092)", async () => {
    const fixture = await createSearchFixture("wiki-v2");
    await writeFile(
      join(fixture.projectPath, "prds", "PRD-001.md"),
      `---\nid: PRD-001\ntitle: Rate limiting design\n---\nbody\n`,
    );
    // qmd can return several chunks of the same file; they collapse to one line.
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([
        { path: "qmd://wiki-v2/prds/PRD-001.md", score: 0.9, snippet: "chunk one" },
        { path: "qmd://wiki-v2/prds/PRD-001.md", score: 0.6, snippet: "chunk two" },
        { path: "qmd://wiki-v2/slices/SLICE-007.md", score: 0.5, snippet: "slice chunk" },
      ]),
    );

    const result = await runWiki(["search", "rate", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `PRD-001\tprd\tRate limiting design\t0.9\tchunk one\n` +
        `SLICE-007\tslice\t\t0.5\tslice chunk\n`,
    );
  });

  test("search --json enriches each hit with id/kind/title (SLICE-0092)", async () => {
    const fixture = await createSearchFixture("wiki-v2");
    await writeFile(
      join(fixture.projectPath, "prds", "PRD-001.md"),
      `---\nid: PRD-001\ntitle: Rate limiting design\n---\nbody\n`,
    );
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([
        { path: "qmd://wiki-v2/prds/PRD-001.md", score: 0.9, snippet: "First\nresult" },
      ]),
    );

    const result = await runWiki(["search", "rate", "--project", "wiki-v2", "--json"], fixture);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "PRD-001", kind: "prd", title: "Rate limiting design", path: "qmd://wiki-v2/prds/PRD-001.md", score: "0.9", snippet: "First result" },
    ]);
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

  test("search --json emits a structured array of hits (SLICE-0088)", async () => {
    const fixture = await createSearchFixture("wiki-v2");
    await writeFile(
      fixture.resultsFile,
      JSON.stringify([
        { path: "qmd://wiki-v2/prds/PRD-001.md", score: 0.9, snippet: "First\nresult" },
        { path: "qmd://wiki-v2/slices/SLICE-001.md", score: 0.72, snippet: "Second result" },
      ]),
    );

    const result = await runWiki(["search", "vault", "--project", "wiki-v2", "--json"], fixture);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "PRD-001", kind: "prd", title: "", path: "qmd://wiki-v2/prds/PRD-001.md", score: "0.9", snippet: "First result" },
      { id: "SLICE-001", kind: "slice", title: "", path: "qmd://wiki-v2/slices/SLICE-001.md", score: "0.72", snippet: "Second result" },
    ]);
  });

  test("search --json emits an empty array on no results (SLICE-0088)", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(["search", "missing", "--project", "wiki-v2", "--json"], fixture);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
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
    expect(result.stdout).toBe("SLICE-001\tslice\t\t0.8\tSlice\n");
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

async function createSearchFixture(project: string, options: SearchFixtureOptions = {}): Promise<SearchFixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-search-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
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
