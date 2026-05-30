import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("handover CLI", () => {
  test("handover create with required flags writes an open handover", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HANDOVER-0001\n");
    expect(result.stderr).toContain("created HANDOVER-0001");
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("id: HANDOVER-0001");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("phase: plan");
    expect(file).toContain("status: open");
  });

  test("handover create missing --phase exits 1", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("phase");
    expect(result.stdout).toBe("");
  });

  test("handover create without --project uses session project", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "--phase", "plan"], vaultRoot);

    expect(result.exitCode).toBe(0);
  });

  test("handover create stores repeated active slices", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      [
        "handover",
        "--project",
        "wiki-v2",
        "--phase",
        "plan",
        "--active-slice",
        "SLICE-0001",
        "--active-slice",
        "SLICE-0002",
      ],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("active_slices:\n  - SLICE-0001\n  - SLICE-0002");
  });

  test("handover create reads produced prose from stdin", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      ["handover", "--project", "wiki-v2", "--phase", "plan", "--produced", "-"],
      vaultRoot,
      "Built one thing\nVerified it",
    );

    expect(result.exitCode).toBe(0);
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("Built one thing\nVerified it");
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
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}

async function readHandover(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "handovers", `${id}-${id.toLowerCase()}.md`), "utf8");
}
