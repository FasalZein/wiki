import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("term CLI", () => {
  test("term set creates architecture folder and domain-language.md", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["term", "set", "Vault", "The locked Obsidian root.", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    const file = await readTerms(vaultRoot);
    expect(file).toContain("# Domain Language\n\n> Canonical terms for this project. Maintained by `wiki term set`.");
    expect(file).toContain("## Vault\n\nThe locked Obsidian root.");
    await expectNoTempFiles(vaultRoot);
  });

  test("term set updates an existing section and preserves other terms", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["term", "set", "Vault", "v1", "--project", "wiki-v2"], vaultRoot);
    await runWiki(["term", "set", "Project", "A folder under `projects/`.", "--project", "wiki-v2"], vaultRoot);

    const result = await runWiki(["term", "set", "Vault", "v2", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    const file = await readTerms(vaultRoot);
    expect(file).toContain("## Vault\n\nv2");
    expect(file).not.toContain("## Vault\n\nv1");
    expect(file).toContain("## Project\n\nA folder under `projects/`.");
    await expectNoTempFiles(vaultRoot);
  });

  test("term set keeps sections in alphabetical order", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["term", "set", "Vault", "The locked Obsidian root.", "--project", "wiki-v2"], vaultRoot);

    const result = await runWiki(["term", "set", "Project", "A folder under `projects/`.", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    const file = await readTerms(vaultRoot);
    expect(file.indexOf("## Project")).toBeLessThan(file.indexOf("## Vault"));
  });

  test("term set reads a multiline body from stdin", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["term", "set", "Vault", "-", "--project", "wiki-v2"], vaultRoot, "Line one\nLine two");

    expect(result.exitCode).toBe(0);
    expect(await readTerms(vaultRoot)).toContain("## Vault\n\nLine one\nLine two");
  });

  test("term show prints a term body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["term", "set", "Vault", "The locked Obsidian root.", "--project", "wiki-v2"], vaultRoot);

    const result = await runWiki(["term", "show", "Vault", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("The locked Obsidian root.\n");
    expect(result.stderr).toBe("");
  });

  test("term show unknown exits 1", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["term", "show", "Unknown", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("term not found: Unknown");
  });

  test("term list prints names alphabetically", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["term", "set", "Vault", "The locked Obsidian root.", "--project", "wiki-v2"], vaultRoot);
    await runWiki(["term", "set", "Project", "A folder under `projects/`.", "--project", "wiki-v2"], vaultRoot);

    const result = await runWiki(["term", "list", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Project\nVault\n");
    expect(result.stderr).toBe("");
  });

  test("term list on missing file exits 0 with empty stdout", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["term", "list", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("term set leaves a fully valid file and no tmp residue after each write", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["term", "set", "Vault", "The locked Obsidian root.", "--project", "wiki-v2"], vaultRoot);
    await expectNoTempFiles(vaultRoot);

    await runWiki(["term", "set", "Project", "A folder under `projects/`.", "--project", "wiki-v2"], vaultRoot);

    const file = await readTerms(vaultRoot);
    expect(file).toStartWith("# Domain Language\n\n> Canonical terms for this project. Maintained by `wiki term set`.\n\n");
    expect(file).toContain("## Project\n\nA folder under `projects/`.");
    expect(file).toContain("## Vault\n\nThe locked Obsidian root.");
    await expectNoTempFiles(vaultRoot);
  });
});

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

async function readTerms(vaultRoot: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "architecture", "domain-language.md"), "utf8");
}

async function expectNoTempFiles(vaultRoot: string): Promise<void> {
  const entries = await readdir(join(vaultRoot, "projects", "wiki-v2", "architecture"));
  expect(entries.filter((entry) => entry.includes(".tmp-"))).toEqual([]);
}
