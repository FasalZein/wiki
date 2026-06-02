import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});

function createArgs(): string[] {
  return ["create", "prd", "--title", "Core wiki CLI", "--project", "wiki-v2"];
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string, stdin?: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh") },
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
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
  await mkdir(join(projectPath, "docs"));
  const qmdCommand = join(vaultRoot, "fake-qmd");
  await writeFile(qmdCommand, "#!/usr/bin/env bash\nset -euo pipefail\ncase \"${1:-}\" in\n  collection) exit 0 ;;\n  query) echo '[]' ;;\nesac\n");
  await chmod(qmdCommand, 0o755);
  await writeFile(join(projectPath, "_project.md"), `---\nqmd_command: ${qmdCommand}\n---\n# ${project}\n`);
  return vaultRoot;
}

async function readPrd(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "prds", `${id}-core-wiki-cli.md`), "utf8");
}
