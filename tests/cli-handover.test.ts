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

    const result = await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

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

    const result = await runWiki(["handover", "create", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("phase");
    expect(result.stdout).toBe("");
  });

  test("handover create without --project uses session project", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "create", "--phase", "plan"], vaultRoot);

    expect(result.exitCode).toBe(0);
  });

  test("handover create stores repeated active slices", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      [
        "handover",
        "create",
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
      ["handover", "create", "--project", "wiki-v2", "--phase", "plan", "--produced", "-"],
      vaultRoot,
      "Built one thing\nVerified it",
    );

    expect(result.exitCode).toBe(0);
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("Built one thing\nVerified it");
  });

  test("handover show prints the rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

    const result = await runWiki(["handover", "show", "HANDOVER-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Handover HANDOVER-0001");
    expect(result.stdout).toContain("## What this session produced");
    expect(result.stderr).toBe("");
  });

  test("handover show --field prints one field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

    const result = await runWiki(
      ["handover", "show", "HANDOVER-0001", "--project", "wiki-v2", "--field", "phase"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("plan\n");
    expect(result.stderr).toBe("");
  });

  test("handover show missing id exits 1", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "show", "HANDOVER-9999", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("HANDOVER-9999");
  });

  test("handover set updates a field and preserves the body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);
    const before = await readHandover(vaultRoot, "HANDOVER-0001");

    const result = await runWiki(
      ["handover", "set", "HANDOVER-0001", "--project", "wiki-v2", "--field", "phase", "review"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    const after = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(after).toContain("phase: review");
    expect(after.slice(after.indexOf("# Handover HANDOVER-0001"))).toBe(before.slice(before.indexOf("# Handover HANDOVER-0001")));
  });

  test("handover append adds to a list field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

    const result = await runWiki(
      ["handover", "append", "HANDOVER-0001", "--project", "wiki-v2", "--field", "suggested_skills", "/wiki"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(await readHandover(vaultRoot, "HANDOVER-0001")).toContain("suggested_skills:\n  - /wiki");
  });

  test("handover append rejects non-list fields", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

    const result = await runWiki(
      ["handover", "append", "HANDOVER-0001", "--project", "wiki-v2", "--field", "phase", "review"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("phase");
    expect(result.stderr).toContain("not a list field");
  });

  test("handover write aliases create", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "write", "--project", "wiki-v2", "--phase", "handover"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HANDOVER-0001\n");
    expect(await readHandover(vaultRoot, "HANDOVER-0001")).toContain("phase: handover");
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
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}

async function readHandover(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "handovers", `${id}.md`), "utf8");
}
