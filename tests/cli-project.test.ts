import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project CLI", () => {
  test("project create creates all required directories", async () => {
    const vaultRoot = await createBareVault();

    const result = await runWiki(["project", "create", "acme"], vaultRoot);

    expect(result.exitCode).toBe(0);
    const projectDir = join(vaultRoot, "projects", "acme");
    const entries = await readdir(projectDir);
    expect(entries).toContain("prds");
    expect(entries).toContain("slices");
    expect(entries).toContain("adrs");
    expect(entries).toContain("handovers");
    expect(entries).toContain("docs");
    expect(entries).not.toContain("architecture");
  });

  test("project create creates _project.md with correct frontmatter", async () => {
    const vaultRoot = await createBareVault();

    await runWiki(["project", "create", "acme"], vaultRoot);

    const content = await readFile(join(vaultRoot, "projects", "acme", "_project.md"), "utf8");
    expect(content).toContain("project: acme");
    expect(content).toContain("status: planning");
    expect(content).toMatch(/created: \d{4}-\d{2}-\d{2}/);
  });

  test("project create does not scaffold architecture domain-language", async () => {
    const vaultRoot = await createBareVault();

    await runWiki(["project", "create", "acme"], vaultRoot);

    await expect(readFile(join(vaultRoot, "projects", "acme", "architecture", "domain-language.md"), "utf8")).rejects.toThrow();
  });

  test("project create with existing project exits 1", async () => {
    const vaultRoot = await createBareVault();
    await mkdir(join(vaultRoot, "projects", "acme"), { recursive: true });

    const result = await runWiki(["project", "create", "acme"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  test("project create without name exits 1", async () => {
    const vaultRoot = await createBareVault();

    const result = await runWiki(["project", "create"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing");
  });

  test("project create prints project path to stdout", async () => {
    const vaultRoot = await createBareVault();

    const result = await runWiki(["project", "create", "acme"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(join(vaultRoot, "projects", "acme"));
    expect(result.stderr).toContain("created project acme");
  });
});

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: {
      ...process.env,
      KNOWLEDGE_VAULT_ROOT: vaultRoot,
    },
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

async function createBareVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  return vaultRoot;
}
