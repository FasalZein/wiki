import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("decision CLI", () => {
  test("decision create writes a new decision file and reports the id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(createArgs(), vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("DECISION-0001\n");
    expect(result.stderr).toContain("created DECISION-0001");

    const file = await readFile(join(vaultRoot, "projects", "wiki-v2", "decisions", "DECISION-0001.md"), "utf8");
    expect(file).toContain("id: DECISION-0001");
    expect(file).toContain("# Use SQLite");
  });

  test("decision create exits 1 and names a missing required field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(createArgs().filter((arg) => arg !== "--title" && arg !== "Use SQLite"), vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });

  test("decision create exits 1 and names a schema-invalid field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const args = createArgs();
    args[args.indexOf("Use SQLite")] = "Tiny";

    const result = await runWiki(args, vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });

  test("decision show prints the rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(["decision", "show", "DECISION-0001", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Use SQLite");
    expect(result.stdout).toContain("## Decision\n\nUse SQLite for local persistence.");
    expect(result.stderr).toBe("");
  });

  test("decision show --field prints only that field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["decision", "show", "DECISION-0001", "--project", "wiki-v2", "--field", "title"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Use SQLite\n");
    expect(result.stderr).toBe("");
  });

  test("decision show exits 1 and names a missing id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["decision", "show", "DECISION-9999", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("DECISION-9999");
  });

  test("decision set updates one field and preserves the body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);
    const before = await readFile(join(vaultRoot, "projects", "wiki-v2", "decisions", "DECISION-0001.md"), "utf8");

    const result = await runWiki(
      ["decision", "set", "DECISION-0001", "--project", "wiki-v2", "--field", "status", "proposed"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated DECISION-0001");
    const after = await readFile(join(vaultRoot, "projects", "wiki-v2", "decisions", "DECISION-0001.md"), "utf8");
    expect(after).toContain("status: proposed");
    expect(after.slice(after.indexOf("# Use SQLite"))).toBe(before.slice(before.indexOf("# Use SQLite")));
  });

  test("decision append adds a value to a list field", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["decision", "append", "DECISION-0001", "--project", "wiki-v2", "--field", "context_terms", "Vault"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("updated DECISION-0001");
    const after = await readFile(join(vaultRoot, "projects", "wiki-v2", "decisions", "DECISION-0001.md"), "utf8");
    expect(after).toContain("context_terms:\n  - Vault");
  });

  test("decision append rejects non-list fields", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki(
      ["decision", "append", "DECISION-0001", "--project", "wiki-v2", "--field", "title", "extra"],
      vaultRoot,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stderr).toContain("not a list field");
  });
});

function createArgs(): string[] {
  return [
    "decision",
    "create",
    "--title",
    "Use SQLite",
    "--context",
    "Need a durable local index.",
    "--decision",
    "Use SQLite for local persistence.",
    "--consequences",
    "Keep migrations small and explicit.",
    "--project",
    "wiki-v2",
  ];
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot },
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
