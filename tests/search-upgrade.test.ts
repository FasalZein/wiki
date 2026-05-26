import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyIntent, type SearchIntent } from "../src/search/intent";
import { normalizeForSemantic } from "../src/search/normalize";
import { buildStructuredQuery } from "../src/search/query-builder";

/* ------------------------------------------------------------------ */
/*  Intent classification                                              */
/* ------------------------------------------------------------------ */

describe("intent classification", () => {
  test("classifies location questions", () => {
    expect(classifyIntent("where do PRDs live")).toBe("location");
    expect(classifyIntent("which file owns auth routing")).toBe("location");
  });

  test("classifies rationale questions", () => {
    expect(classifyIntent("why did we choose qmd")).toBe("rationale");
    expect(classifyIntent("compare the tradeoffs of qmd search vs query")).toBe("rationale");
  });

  test("classifies implementation questions", () => {
    expect(classifyIntent("how does verification work")).toBe("implementation");
    expect(classifyIntent("show me the code for caching")).toBe("implementation");
    expect(classifyIntent("implementation of the query pipeline")).toBe("implementation");
    expect(classifyIntent("what does the cache layer do")).toBe("implementation");
  });

  test("classifies temporal questions", () => {
    expect(classifyIntent("what changed in the last week")).toBe("temporal");
    expect(classifyIntent("recent changes to retrieval")).toBe("temporal");
  });

  test("leaves other questions as general", () => {
    expect(classifyIntent("list all specs")).toBe("general");
  });
});

/* ------------------------------------------------------------------ */
/*  Semantic normalization                                             */
/* ------------------------------------------------------------------ */

describe("semantic normalization", () => {
  test("normalizes hyphenated project names", () => {
    expect(normalizeForSemantic("wiki-forge")).toBe("wiki forge");
  });

  test("strips unary negation syntax", () => {
    expect(normalizeForSemantic('auth -legacy -"old flow"')).toBe('auth legacy "old flow"');
  });
});

/* ------------------------------------------------------------------ */
/*  Structured query building                                          */
/* ------------------------------------------------------------------ */

describe("structured query building", () => {
  test("all queries include lex and vec lines", () => {
    const result = buildStructuredQuery("list all specs", { intent: "general" });
    expect(result).toContain("lex: list all specs");
    expect(result).toContain("vec:");
  });

  test("project context appears in intent line", () => {
    const result = buildStructuredQuery("where do PRDs live", {
      intent: "location",
      project: "wiki-v2",
    });
    expect(result).toContain("intent:");
    expect(result).toContain("wiki-v2");
  });

  test("rationale queries include hyde line", () => {
    const result = buildStructuredQuery("why did we choose qmd", { intent: "rationale" });
    expect(result).toContain("hyde: The answer is:");
  });

  test("implementation queries include hyde line", () => {
    const result = buildStructuredQuery("how does caching work", { intent: "implementation" });
    expect(result).toContain("hyde: The answer is:");
  });

  test("location queries do NOT include hyde line", () => {
    const result = buildStructuredQuery("where do PRDs live", { intent: "location" });
    expect(result).not.toContain("hyde:");
  });

  test("general queries do NOT include hyde line", () => {
    const result = buildStructuredQuery("list all specs", { intent: "general" });
    expect(result).not.toContain("hyde:");
  });

  test("location queries tighten lex terms (remove stop words, add domain hints)", () => {
    const result = buildStructuredQuery("where do PRDs live", { intent: "location" });
    expect(result).toContain("lex: PRDs prd spec specs");
    // Vec still uses the full normalized query
    expect(result).toContain("vec: where do PRDs live");
  });
});

/* ------------------------------------------------------------------ */
/*  CLI integration (--explain, --no-refresh)                          */
/* ------------------------------------------------------------------ */

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type SearchFixture = {
  vaultRoot: string;
  projectPath: string;
  researchPath: string;
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

async function createSearchFixture(project: string): Promise<SearchFixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-search-upgrade-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
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
printf '%s\\n' "$*" >> "$STATE_FILE"
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
  update)
    # just log it
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
    researchPath,
    stateFile,
    resultsFile,
    env: {
      QMD_COMMAND: qmdCommand,
      STATE_FILE: stateFile,
      REGISTERED_FILE: registeredFile,
      RESULTS_FILE: resultsFile,
      FAIL_QUERY: "0",
    },
  };
}

describe("CLI --explain flag", () => {
  test("--explain is passed through to qmd query", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(
      ["search", "why did we choose qmd", "--project", "wiki-v2", "--explain"],
      fixture,
    );

    expect(result.exitCode).toBe(0);
    const log = await readFile(fixture.stateFile, "utf8");
    expect(log).toContain("--explain");
  });
});

describe("CLI --no-refresh flag", () => {
  test("--no-refresh skips updateCollection call", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(
      ["search", "list all specs", "--project", "wiki-v2", "--no-refresh"],
      fixture,
    );

    expect(result.exitCode).toBe(0);
    const log = await readFile(fixture.stateFile, "utf8");
    // Should NOT contain an update command
    expect(log).not.toContain("update");
  });

  test("auto-refresh runs by default (without --no-refresh)", async () => {
    const fixture = await createSearchFixture("wiki-v2");

    const result = await runWiki(
      ["search", "list all specs", "--project", "wiki-v2"],
      fixture,
    );

    expect(result.exitCode).toBe(0);
    const log = await readFile(fixture.stateFile, "utf8");
    // Should contain an update command
    expect(log).toContain("update");
  });
});
