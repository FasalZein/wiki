import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("doc CLI", () => {
  test("doc create writes a new doc file and reports the id", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki(createArgs(), vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("DOC-0001\n");
    expect(result.stderr).toContain("created DOC-0001");

    const file = await readDoc(vaultRoot, "DOC-0001");
    expect(file).toContain("id: DOC-0001");
    expect(file).toContain("title: Pre-deploy checklist for Kamal services");
    expect(file).toContain("project: test-project");
    expect(file).toContain("type: runbook");
  });

  test("doc create places the file under docs/<category> when --category is given", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "Evidence-first architecture",
      "--project", "test-project",
      "--type", "reference",
      "--category", "architecture",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const path = join(vaultRoot, "projects", "test-project", "docs", "architecture", "DOC-0001-evidence-first-architecture.md");
    expect(await readFile(path, "utf8")).toContain("id: DOC-0001");
  });

  test("doc create derives the category from type when --category is omitted", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    await runWiki(createArgs(), vaultRoot); // type runbook -> docs/runbooks/

    const path = join(vaultRoot, "projects", "test-project", "docs", "runbooks", "DOC-0001-pre-deploy-checklist-for-kamal-services.md");
    expect(await readFile(path, "utf8")).toContain("id: DOC-0001");
  });

  test("doc create routes an unmapped type to notes (the catch-all), not specs", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    // `reference` has no explicit category mapping -> should land in notes/, not specs/.
    await runWiki([
      "create", "doc",
      "--title", "Some reference doc title",
      "--project", "test-project",
      "--type", "reference",
    ], vaultRoot);

    const notesPath = join(vaultRoot, "projects", "test-project", "docs", "notes", "DOC-0001-some-reference-doc-title.md");
    expect(await readFile(notesPath, "utf8")).toContain("id: DOC-0001");
  });

  test("doc create exits 1 for an unknown category", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "Some valid title here",
      "--project", "test-project",
      "--type", "reference",
      "--category", "blueprints",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("category");
  });

  test("doc create with tags passes them through", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "AWS migration research",
      "--project", "test-project",
      "--type", "research",
      "--tags", "aws,migration,infra",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const file = await readDoc(vaultRoot, "DOC-0001");
    expect(file).toContain("type: research");
    expect(file).toContain("aws");
    expect(file).toContain("migration");
  });

  test("doc create exits 1 when title is missing", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--project", "test-project",
      "--type", "runbook",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
  });

  test("doc create exits 1 when type is missing", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "Some doc",
      "--project", "test-project",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("type");
  });

  test("doc create exits 1 for invalid type enum value", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "Some valid title here",
      "--project", "test-project",
      "--type", "blog-post",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("type");
  });

  test("doc create increments IDs", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    await runWiki(createArgs(), vaultRoot);
    const result = await runWiki([
      "create", "doc",
      "--title", "Another knowledge doc here",
      "--project", "test-project",
      "--type", "guide",
      "--force-new", "Testing sequential ID generation for doc artifacts",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("DOC-0002\n");
  });

  test("validate recognizes docs/ path", async () => {
    const vaultRoot = await createFixtureVault("test-project");
    await runWiki(createArgs(), vaultRoot);

    const docPath = join(vaultRoot, "projects", "test-project", "docs", "runbooks", "DOC-0001-pre-deploy-checklist-for-kamal-services.md");
    const result = await runWiki(["validate", docPath], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("valid doc");
  });

  test("doc retitle updates the title and renames the file, still resolvable by id", async () => {
    const vaultRoot = await createFixtureVault("test-project");
    await runWiki(createArgs(), vaultRoot); // DOC-0001 in docs/runbooks/

    const result = await runWiki([
      "doc", "retitle", "DOC-0001",
      "--project", "test-project",
      "--title", "Kamal deploy preflight checklist",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const oldPath = join(vaultRoot, "projects", "test-project", "docs", "runbooks", "DOC-0001-pre-deploy-checklist-for-kamal-services.md");
    const newPath = join(vaultRoot, "projects", "test-project", "docs", "runbooks", "DOC-0001-kamal-deploy-preflight-checklist.md");
    expect(await fileExists(oldPath)).toBe(false);
    const file = await readFile(newPath, "utf8");
    expect(file).toContain("title: Kamal deploy preflight checklist");
    expect(file).toContain("id: DOC-0001");
  });

  test("doc recategorize moves the file to docs/<category>, still resolvable by id", async () => {
    const vaultRoot = await createFixtureVault("test-project");
    await runWiki(createArgs(), vaultRoot); // DOC-0001 in docs/runbooks/

    const result = await runWiki([
      "doc", "recategorize", "DOC-0001",
      "--project", "test-project",
      "--category", "architecture",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const oldPath = join(vaultRoot, "projects", "test-project", "docs", "runbooks", "DOC-0001-pre-deploy-checklist-for-kamal-services.md");
    const newPath = join(vaultRoot, "projects", "test-project", "docs", "architecture", "DOC-0001-pre-deploy-checklist-for-kamal-services.md");
    expect(await fileExists(oldPath)).toBe(false);
    expect(await fileExists(newPath)).toBe(true);
    expect(await readFile(newPath, "utf8")).toContain("id: DOC-0001");
  });

  test("doc recategorize exits 1 for an unknown category", async () => {
    const vaultRoot = await createFixtureVault("test-project");
    await runWiki(createArgs(), vaultRoot);

    const result = await runWiki([
      "doc", "recategorize", "DOC-0001",
      "--project", "test-project",
      "--category", "blueprints",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("category");
  });

  test("doc retitle exits 1 when the doc id does not exist", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "doc", "retitle", "DOC-0099",
      "--project", "test-project",
      "--title", "Whatever new title here",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

function createArgs(): string[] {
  return ["create", "doc", "--title", "Pre-deploy checklist for Kamal services", "--project", "test-project", "--type", "runbook"];
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
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
  await mkdir(join(projectPath, "docs"));
  const qmdCommand = join(vaultRoot, "fake-qmd");
  await writeFile(qmdCommand, "#!/usr/bin/env bash\nset -euo pipefail\ncase \"${1:-}\" in\n  collection) exit 0 ;;\n  query) echo '[]' ;;\nesac\n");
  await chmod(qmdCommand, 0o755);
  await writeFile(join(projectPath, "_project.md"), `---\nqmd_command: ${qmdCommand}\n---\n# ${project}\n`);
  return vaultRoot;
}

async function readDoc(vaultRoot: string, id: string): Promise<string> {
  const docsDir = join(vaultRoot, "projects", "test-project", "docs");
  const fileName = (await Array.fromAsync(new Bun.Glob(`**/${id}*.md`).scan({ cwd: docsDir })))[0];
  if (fileName === undefined) throw new Error(`doc not found: ${id}`);
  return readFile(join(docsDir, fileName), "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
