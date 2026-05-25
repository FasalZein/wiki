import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plan CLI", () => {
  test("plan create writes a CLI-state plan file and reports the id", async () => {
    const fixture = await createFixture("wiki-v2");

    const result = await runWiki(createArgs(), fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("PLAN-0001\n");
    expect(result.stderr).toContain("created PLAN-0001");
    const plan = JSON.parse(await readPlan(fixture.repoRoot, "PLAN-0001"));
    expect(plan).toEqual({
      id: "PLAN-0001",
      title: "Core wiki CLI",
      project: "wiki-v2",
      status: "draft",
      problem_drafts: [],
      solution_drafts: [],
      acceptance_drafts: [],
      user_stories_drafts: [],
      notes: "",
    });
  });

  test("plan create exits 1 when title is missing", async () => {
    const fixture = await createFixture("wiki-v2");

    const result = await runWiki(createArgs().filter((arg) => arg !== "--title" && arg !== "Core wiki CLI"), fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });

  test("plan create exits 1 when project is missing", async () => {
    const fixture = await createFixture("wiki-v2");

    const result = await runWiki(createArgs().filter((arg) => arg !== "--project" && arg !== "wiki-v2"), fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("project");
    expect(result.stdout).toBe("");
  });

  test("plan create exits 10 when repo cannot be resolved", async () => {
    const vaultRoot = await createFixtureVaultWithoutRepo("wiki-v2");

    const result = await runWiki(createArgs(), vaultRoot);

    expect(result.exitCode).toBe(10);
    expect(result.stderr).toContain("_project.md");
  });

  test("plan show prints pretty JSON", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);

    const result = await runWiki(["plan", "show", "PLAN-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"id": "PLAN-0001"');
    expect(result.stdout).toContain('"title": "Core wiki CLI"');
    expect(result.stderr).toBe("");
  });

  test("plan show --field prints a field value", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);

    const result = await runWiki(["plan", "show", "PLAN-0001", "--project", "wiki-v2", "--field", "title"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Core wiki CLI\n");
    expect(result.stderr).toBe("");
  });

  test("plan show exits 1 for a missing id", async () => {
    const fixture = await createFixture("wiki-v2");

    const result = await runWiki(["plan", "show", "PLAN-9999", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("PLAN-9999");
  });

  test("plan set updates one field and preserves other fields", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);

    const result = await runWiki(["plan", "set", "PLAN-0001", "--project", "wiki-v2", "--field", "notes", "Remember this"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(await readPlan(fixture.repoRoot, "PLAN-0001"));
    expect(plan.notes).toBe("Remember this");
    expect(plan.title).toBe("Core wiki CLI");
  });

  test("plan set reads stdin for string and list fields", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);

    const stringResult = await runWiki(["plan", "set", "PLAN-0001", "--project", "wiki-v2", "--field", "notes", "-"], fixture.vaultRoot, "Line one\nLine two");
    const listResult = await runWiki(["plan", "set", "PLAN-0001", "--project", "wiki-v2", "--field", "problem_drafts", "-"], fixture.vaultRoot, "Problem one\nProblem two\n");

    expect(stringResult.exitCode).toBe(0);
    expect(listResult.exitCode).toBe(0);
    const plan = JSON.parse(await readPlan(fixture.repoRoot, "PLAN-0001"));
    expect(plan.notes).toBe("Line one\nLine two");
    expect(plan.problem_drafts).toEqual(["Problem one", "Problem two"]);
  });

  test("plan append adds to a list field", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);

    const result = await runWiki(["plan", "append", "PLAN-0001", "--project", "wiki-v2", "--field", "acceptance_drafts", "First criterion"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(await readPlan(fixture.repoRoot, "PLAN-0001"));
    expect(plan.acceptance_drafts).toEqual(["First criterion"]);
  });

  test("plan append rejects non-list fields", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);

    const result = await runWiki(["plan", "append", "PLAN-0001", "--project", "wiki-v2", "--field", "title", "extra"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stderr).toContain("not a list field");
  });

  test("plan promote creates a PRD from drafts and deletes the plan", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);
    await runWiki(["plan", "set", "PLAN-0001", "--project", "wiki-v2", "--field", "problem_drafts", "-"], fixture.vaultRoot, "Problem one\nProblem two");
    await runWiki(["plan", "append", "PLAN-0001", "--project", "wiki-v2", "--field", "solution_drafts", "Solution one"], fixture.vaultRoot);
    await runWiki(["plan", "append", "PLAN-0001", "--project", "wiki-v2", "--field", "user_stories_drafts", "1. As a user, I want plans."], fixture.vaultRoot);

    const result = await runWiki(["plan", "promote", "PLAN-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("PRD-0001\n");
    expect(result.stderr).toContain("created PRD-0001 from PLAN-0001");
    expect(existsSync(join(fixture.repoRoot, ".wiki", "state", "plans", "PLAN-0001.json"))).toBe(false);
    const prd = await readPrd(fixture.vaultRoot, "PRD-0001");
    expect(prd).toContain("title: Core wiki CLI");
    expect(prd).toContain("problem_statement: |-\n  Problem one\n\n  Problem two");
    expect(prd).toContain("solution: Solution one");
    expect(prd).toContain("user_stories: '1. As a user, I want plans.'");
  });

  test("plan promote exits 1 for a missing title and keeps the plan", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);
    await runWiki(["plan", "set", "PLAN-0001", "--project", "wiki-v2", "--field", "title", ""], fixture.vaultRoot);

    const result = await runWiki(["plan", "promote", "PLAN-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(existsSync(join(fixture.repoRoot, ".wiki", "state", "plans", "PLAN-0001.json"))).toBe(true);
  });

  test("plan promote keeps the plan if PRD creation fails", async () => {
    const fixture = await createFixture("wiki-v2");
    await runWiki(createArgs(), fixture.vaultRoot);
    await rm(join(fixture.vaultRoot, "projects", "wiki-v2", "prds"), { recursive: true, force: true });

    const result = await runWiki(["plan", "promote", "PLAN-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(10);
    expect(result.stderr).toContain("promotion failed");
    expect(result.stderr).toContain("PLAN-0001");
    expect(existsSync(join(fixture.repoRoot, ".wiki", "state", "plans", "PLAN-0001.json"))).toBe(true);
  });
});

function createArgs(): string[] {
  return ["plan", "create", "--title", "Core wiki CLI", "--project", "wiki-v2"];
}

type Fixture = {
  vaultRoot: string;
  repoRoot: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string, stdin?: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot },
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

async function createFixture(project: string): Promise<Fixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), "wiki-repo-"));
  tempPaths.push(repoRoot);
  const vaultRoot = await createFixtureVault(project, repoRoot);
  return { vaultRoot, repoRoot };
}

async function createFixtureVault(project: string, repo: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "decisions"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: ${JSON.stringify(repo)}\ntest_command: bun test\n---\n# ${project}\n`);
  return vaultRoot;
}

async function createFixtureVaultWithoutRepo(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "decisions"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}

async function readPlan(repoRoot: string, id: string): Promise<string> {
  return readFile(join(repoRoot, ".wiki", "state", "plans", `${id}.json`), "utf8");
}

async function readPrd(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "prds", `${id}.md`), "utf8");
}
