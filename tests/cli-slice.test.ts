import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("slice CLI", () => {
  test("slice create writes a new slice file with defaults and reports the id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);

    const result = await runWiki(createArgs(), vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SLICE-0001\n");
    expect(result.stderr).toContain("created SLICE-0001");

    const file = await readSlice(vaultRoot, "SLICE-0001");
    expect(file).toContain("id: SLICE-0001");
    expect(file).toContain("title: Build slice authoring");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("parent_prd: PRD-0001");
    expect(file).toContain("status: planned");
    expect(file).toContain("type: AFK");
    expect(file).toContain("acceptance: []");
    expect(file).toContain("# Build slice authoring");
  });

  test("slice show prints the rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["slice", "show", "SLICE-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Build slice authoring");
    expect(result.stdout).toContain("## What to build");
    expect(result.stdout).toContain("[[PRD-0001]]");
    expect(result.stderr).toBe("");
  });

  test("slice show --field prints only that field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["slice", "show", "SLICE-0001", "--project", "wiki-v2", "--field", "title"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Build slice authoring\n");
    expect(result.stderr).toBe("");
  });

  test("slice set updates one field and preserves the body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);
    const before = await readSlice(vaultRoot, "SLICE-0001");

    const result = await runWiki(
      ["slice", "set", "SLICE-0001", "--project", "wiki-v2", "--field", "title", "Updated slice title"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated SLICE-0001");
    const after = await readSlice(vaultRoot, "SLICE-0001");
    expect(after).toContain("title: Updated slice title");
    expect(after.slice(after.indexOf("# Build slice authoring"))).toBe(before.slice(before.indexOf("# Build slice authoring")));
  });

  test("slice set status accepts a valid closed value without state enforcement", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["slice", "set", "SLICE-0001", "--project", "wiki-v2", "--field", "status", "closed"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated SLICE-0001");
    expect(await readSlice(vaultRoot, "SLICE-0001")).toContain("status: closed");
  });

  test("slice set reads a multiline placeholder value from stdin when value is dash", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["slice", "set", "SLICE-0001", "--project", "wiki-v2", "--field", "what_to_build", "-"],
      vaultRoot,
      "First line\nSecond line",
    );

    expect(result.exitCode).toBe(0);
    const show = await runWiki(
      ["slice", "show", "SLICE-0001", "--project", "wiki-v2", "--field", "what_to_build"],
      vaultRoot,
    );
    expect(show.stdout).toBe("First line\nSecond line\n");
  });

  test("slice append adds a value to the acceptance list", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "acceptance", "First criterion"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated SLICE-0001");
    expect(await readSlice(vaultRoot, "SLICE-0001")).toContain("acceptance:\n  - First criterion");
  });

  test("slice append adds a value to the todo list", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "todo", "Write tests"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated SLICE-0001");
    expect(await readSlice(vaultRoot, "SLICE-0001")).toContain("todo:\n  - Write tests");
  });
});

function createArgs(): string[] {
  return [
    "slice",
    "create",
    "--title",
    "Build slice authoring",
    "--project",
    "wiki-v2",
    "--parent-prd",
    "PRD-0001",
  ];
}

async function seedPrd(vaultRoot: string): Promise<void> {
  const result = await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", "wiki-v2"], vaultRoot);
  expect(result.exitCode).toBe(0);
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

async function readSlice(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "slices", `${id}.md`), "utf8");
}
