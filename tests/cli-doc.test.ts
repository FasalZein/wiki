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
    // SLICE-0117: the doc `type` enum is gone; docs carry no type field.
    expect(file).not.toContain("type:");
  });

  test("doc create places the file under docs/<category> when --category is given", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "Evidence-first architecture",
      "--summary", "Evidence-first architecture overview.",
      "--project", "test-project",
      "--category", "architecture",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const path = join(vaultRoot, "projects", "test-project", "docs", "architecture", "DOC-0001-evidence-first-architecture.md");
    expect(await readFile(path, "utf8")).toContain("id: DOC-0001");
  });

  test("doc create with no --category defaults to the notes bucket (SLICE-0117)", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    // With the doc `type` enum removed, a bare create files into notes/, the
    // catch-all bucket, not loose in docs/.
    await runWiki([
      "create", "doc",
      "--title", "Some reference doc title",
      "--summary", "A reference doc for routing test.",
      "--project", "test-project",
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
      "--summary", "Research on the AWS migration.",
      "--project", "test-project",
      "--category", "research",
      "--tags", "aws,migration,infra",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const file = await readDoc(vaultRoot, "DOC-0001");
    expect(file).toContain("aws");
    expect(file).toContain("migration");
  });

  test("doc create exits 1 when title is missing", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--project", "test-project",
    ], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("title");
  });

  test("doc create no longer requires --type and creates with no type field (SLICE-0117)", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    const result = await runWiki([
      "create", "doc",
      "--title", "Some doc title here",
      "--summary", "A doc with no type field.",
      "--project", "test-project",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const file = await readDoc(vaultRoot, "DOC-0001");
    expect(file).not.toContain("type:");
  });

  test("doc create rejects the removed --type flag (SLICE-0117)", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    // The doc `type` enum is gone, so --type is an unknown flag and fails parsing.
    const result = await runWiki([
      "create", "doc",
      "--title", "Some valid title here",
      "--summary", "A doc summary line here.",
      "--project", "test-project",
      "--type", "blog-post",
    ], vaultRoot);

    expect(result.exitCode).not.toBe(0);
  });

  test("doc create increments IDs", async () => {
    const vaultRoot = await createFixtureVault("test-project");

    await runWiki(createArgs(), vaultRoot);
    const result = await runWiki([
      "create", "doc",
      "--title", "Another knowledge doc here",
      "--summary", "Another knowledge doc for IDs.",
      "--project", "test-project",
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

  test("doc retitle --json emits {id,path} (SLICE-0088)", async () => {
    const vaultRoot = await createFixtureVault("test-project");
    await runWiki(createArgs(), vaultRoot); // DOC-0001 in docs/runbooks/

    const result = await runWiki([
      "doc", "retitle", "DOC-0001",
      "--project", "test-project",
      "--title", "Kamal deploy preflight checklist",
      "--json",
    ], vaultRoot);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe("DOC-0001");
    expect(parsed.path).toContain("DOC-0001-kamal-deploy-preflight-checklist.md");
  });
});

function createArgs(): string[] {
  return ["create", "doc", "--title", "Pre-deploy checklist for Kamal services", "--summary", "Pre-deploy checklist for Kamal.", "--project", "test-project", "--category", "runbooks"];
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
  await mkdir(join(projectPath, "handoffs"));
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
