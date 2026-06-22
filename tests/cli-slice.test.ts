import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

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

  test("slice create succeeds without a parent PRD (parent_prd is optional)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      createArgs().filter((arg) => arg !== "--parent-prd" && arg !== "PRD-0001"),
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SLICE-0001\n");

    const file = await readSlice(vaultRoot, "SLICE-0001");
    expect(file).toContain("id: SLICE-0001");
    expect(file).not.toContain("parent_prd:");
  });

  test("slice create backlinks its id into the parent PRD slices list, without clobbering", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);

    const first = await runWiki(createArgs(), vaultRoot);
    expect(first.exitCode).toBe(0);
    const second = await runWiki(
      ["create", "slice", "--title", "Second slice authoring", "--project", "wiki-v2", "--parent-prd", "PRD-0001"],
      vaultRoot,
    );
    expect(second.exitCode).toBe(0);

    const prd = matter(await readPrd(vaultRoot));
    expect(prd.data.slices).toEqual(["SLICE-0001", "SLICE-0002"]);
  });

  test("backlink creates the slices field when the parent PRD lacks one", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    // Strip the default `slices: []` to exercise the create-if-absent path.
    const prdPath = join(vaultRoot, "projects", "wiki-v2", "prds", "PRD-0001-core-wiki-cli.md");
    const stripped = (await readFile(prdPath, "utf8")).replace(/^slices:.*$\n/m, "");
    await writeFile(prdPath, stripped);

    const result = await runWiki(createArgs(), vaultRoot);
    expect(result.exitCode).toBe(0);

    const prd = matter(await readPrd(vaultRoot));
    expect(prd.data.slices).toEqual(["SLICE-0001"]);
  });

  test("slice create exits 1 and names a missing title", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);

    const result = await runWiki(
      createArgs().filter((arg) => arg !== "--title" && arg !== "Build slice authoring"),
      vaultRoot,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });

  test("slice create exits 1 and names a missing project", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    // No --project AND no repo session -> project is unresolvable. Run from a clean
    // cwd with no .wiki session so the cwd-session fallback finds nothing.
    const emptyCwd = await mkdtemp(join(tmpdir(), "wiki-nosession-"));
    tempPaths.push(emptyCwd);

    const result = await runWiki(
      createArgs().filter((arg) => arg !== "--project" && arg !== "wiki-v2"),
      vaultRoot,
      undefined,
      emptyCwd,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("project");
    expect(result.stdout).toBe("");
  });

  test("slice create leaves no literal template syntax in the body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);

    const result = await runWiki(createArgs(), vaultRoot);
    expect(result.exitCode).toBe(0);

    const file = await readSlice(vaultRoot, "SLICE-0001");
    expect(matter(file).content).not.toContain("{{");
  });

  test("slice create exits 1 and names a schema-invalid title", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);
    const args = createArgs();
    args[args.indexOf("Build slice authoring")] = "Tiny";

    const result = await runWiki(args, vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
    expect(result.stdout).toBe("");
  });
});

function createArgs(): string[] {
  return [
    "create",
    "slice",
    "--title",
    "Build slice authoring",
    "--project",
    "wiki-v2",
    "--parent-prd",
    "PRD-0001",
  ];
}

async function seedPrd(vaultRoot: string): Promise<void> {
  const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--project", "wiki-v2"], vaultRoot);
  expect(result.exitCode).toBe(0);
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string, stdin?: string, cwd?: string): Promise<CommandResult> {
  const repoRoot = import.meta.dir.replace(/\/tests$/, "");
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: cwd ?? repoRoot,
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
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  const qmdCommand = join(vaultRoot, "fake-qmd");
  await writeFile(qmdCommand, "#!/usr/bin/env bash\nset -euo pipefail\ncase \"${1:-}\" in\n  collection) exit 0 ;;\n  query) echo '[]' ;;\nesac\n");
  await chmod(qmdCommand, 0o755);
  await writeFile(join(projectPath, "_project.md"), `---\nqmd_command: ${qmdCommand}\n---\n# ${project}\n`);
  return vaultRoot;
}

async function readSlice(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "slices", `${id}-build-slice-authoring.md`), "utf8");
}

async function readPrd(vaultRoot: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "prds", "PRD-0001-core-wiki-cli.md"), "utf8");
}
