import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("prd CLI", () => {
  test("prd create writes a new PRD file and reports the id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(createArgs(), vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("PRD-0001\n");
    expect(result.stderr).toContain("created PRD-0001");

    const file = await readPrd(vaultRoot, "PRD-0001");
    expect(file).toContain("id: PRD-0001");
    expect(file).toContain("title: Core wiki CLI");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("status: draft");
    expect(file).toContain("# Core wiki CLI");
  });

  test("prd create exits 1 and names a missing required field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(createArgs().filter((arg) => arg !== "--title" && arg !== "Core wiki CLI"), vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });

  test("prd create exits 1 and names a schema-invalid field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const args = createArgs();
    args[args.indexOf("Core wiki CLI")] = "Tiny";

    const result = await runWiki(args, vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });

  test("prd show prints the rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["prd", "show", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Core wiki CLI");
    expect(result.stdout).toContain("## Problem Statement");
    expect(result.stdout).toContain("_None yet. Run `wiki slice create --prd PRD-0001` to add._");
    expect(result.stderr).toBe("");
  });

  test("prd show --field prints only that field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["prd", "show", "PRD-0001", "--project", "wiki-v2", "--field", "title"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Core wiki CLI\n");
    expect(result.stderr).toBe("");
  });

  test("prd show exits 1 and names a missing id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["prd", "show", "PRD-9999", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("PRD-9999");
  });

  test("prd set updates one field and preserves the body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);
    const before = await readPrd(vaultRoot, "PRD-0001");

    const result = await runWiki(
      ["prd", "set", "PRD-0001", "--project", "wiki-v2", "--field", "status", "superseded"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated PRD-0001");
    const after = await readPrd(vaultRoot, "PRD-0001");
    expect(after).toContain("status: superseded");
    expect(after.slice(after.indexOf("# Core wiki CLI"))).toBe(before.slice(before.indexOf("# Core wiki CLI")));
  });

  test("prd set reads a multiline value from stdin when value is dash", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["prd", "set", "PRD-0001", "--project", "wiki-v2", "--field", "problem_statement", "-"],
      vaultRoot,
      "First line\nSecond line",
    );

    expect(result.exitCode).toBe(0);
    const show = await runWiki(
      ["prd", "show", "PRD-0001", "--project", "wiki-v2", "--field", "problem_statement"],
      vaultRoot,
    );
    expect(show.stdout).toBe("First line\nSecond line\n");
  });

  test("prd append adds a value to a list field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["prd", "append", "PRD-0001", "--project", "wiki-v2", "--field", "domain_terms", "Vault"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated PRD-0001");
    const after = await readPrd(vaultRoot, "PRD-0001");
    expect(after).toContain("domain_terms:\n  - Vault");
  });

  test("prd append rejects non-list fields", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["prd", "append", "PRD-0001", "--project", "wiki-v2", "--field", "title", "extra"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stderr).toContain("not a list field");
  });

  test("prd publish transitions draft to ready", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated PRD-0001");
    expect(await readPrd(vaultRoot, "PRD-0001")).toContain("status: ready");
  });

  test("prd publish exits 2 when the PRD is already ready", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);
    await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    const result = await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot publish PRD-0001 from status ready");
    expect(await readPrd(vaultRoot, "PRD-0001")).toContain("status: ready");
  });

  test("prd close transitions ready to closed", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);
    await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    const result = await runWiki(["prd", "close", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated PRD-0001");
    expect(await readPrd(vaultRoot, "PRD-0001")).toContain("status: closed");
  });

  test("prd close exits 2 when the PRD is draft", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["prd", "close", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot close PRD-0001 from status draft");
    expect(await readPrd(vaultRoot, "PRD-0001")).toContain("status: draft");
  });

  test("prd close exits 2 when the PRD is already closed", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);
    await runWiki(["prd", "set", "PRD-0001", "--project", "wiki-v2", "--field", "status", "closed"], vaultRoot);

    const result = await runWiki(["prd", "close", "PRD-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot close PRD-0001 from status closed");
    expect(await readPrd(vaultRoot, "PRD-0001")).toContain("status: closed");
  });
});

function createArgs(): string[] {
  return ["prd", "create", "--title", "Core wiki CLI", "--project", "wiki-v2"];
}

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

async function createFixtureVault(project: string): Promise<string> {
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

async function readPrd(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "prds", `${id}.md`), "utf8");
}
