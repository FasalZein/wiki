import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("supersede tolerates a schema-stale target (PRD-0020)", () => {
  test("create --supersedes succeeds when the target predates a now-required field", async () => {
    const f = await fixture();
    const old = await seedSlice(f);
    await stripField(f, old, "summary");

    const result = await runWiki([
      "create", "slice",
      "--title", "Replacement slice for stale target",
      "--summary", "Replacement slice supersedes the schema-stale one.",
      "--project", "wiki-v2",
      "--parent-prd", "PRD-0001",
      "--acceptance", "does the thing",
      "--supersedes", old,
    ], f);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("summary: required");
    const newId = result.stdout.trim();

    const target = await readSlice(f, old);
    expect(target).toContain("status: superseded");
    expect(target).toContain(`superseded_by: ${newId}`);
  });

  test("a normal supersede of a fully-valid target still works", async () => {
    const f = await fixture();
    const old = await seedSlice(f);

    const result = await runWiki([
      "create", "slice",
      "--title", "Replacement slice for valid target",
      "--summary", "Replacement slice supersedes the valid one.",
      "--project", "wiki-v2",
      "--parent-prd", "PRD-0001",
      "--acceptance", "does the thing",
      "--supersedes", old,
    ], f);

    expect(result.exitCode).toBe(0);
    const newId = result.stdout.trim();
    const target = await readSlice(f, old);
    expect(target).toContain("status: superseded");
    expect(target).toContain(`superseded_by: ${newId}`);
  });

  test("a genuinely invalid NEW artifact still fails (relaxation is target-only)", async () => {
    const f = await fixture();
    const old = await seedSlice(f);
    await stripField(f, old, "summary");

    const result = await runWiki([
      "create", "slice",
      "--title", "Replacement slice with bad summary",
      "--summary", "short", // below min:10 — new artifact must still fail
      "--project", "wiki-v2",
      "--parent-prd", "PRD-0001",
      "--acceptance", "does the thing",
      "--supersedes", old,
    ], f);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("summary");
    // target untouched: still not marked superseded
    const target = await readSlice(f, old);
    expect(target).not.toContain("status: superseded");
  });
});

type Fixture = { vaultRoot: string; projectPath: string; env: Record<string, string> };

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-supersede-stale-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", "wiki-v2");
  for (const dir of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(projectPath, dir), { recursive: true });
  }
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: /tmp/repo\ntest_command: bun test\n---\n# wiki-v2\n`);

  const qmdCommand = join(root, "fake-qmd");
  await writeFile(qmdCommand, `#!/usr/bin/env bash\nset -euo pipefail\ncase "\${1:-}" in\n  collection) ;;\n  query) echo "[]" ;;\nesac\n`);
  await chmod(qmdCommand, 0o755);

  return { vaultRoot, projectPath, env: { QMD_COMMAND: qmdCommand } };
}

/** Seed one slice (and its parent PRD once) via the real create path; return the new slice id. */
async function seedSlice(f: Fixture): Promise<string> {
  if ((await readdir(join(f.projectPath, "prds"))).length === 0) {
    const prd = await runWiki(["create", "prd", "--title", "Parent PRD for stale supersede tests", "--summary", "Parent PRD for stale supersede tests.", "--project", "wiki-v2", "--force-new", "Seeding a parent PRD for the stale supersede tests"], f);
    expect(prd.exitCode).toBe(0);
  }
  const result = await runWiki(["create", "slice", "--title", "Slice that will be superseded", "--summary", "Slice that will be superseded by a replacement.", "--project", "wiki-v2", "--parent-prd", "PRD-0001", "--acceptance", "does the thing", "--force-new", "Seeding a slice to supersede in the stale-target tests"], f);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

/** Remove a frontmatter field line from the target file to simulate schema drift. */
async function stripField(f: Fixture, id: string, field: string): Promise<void> {
  const name = await sliceFileName(f, id);
  const path = join(f.projectPath, "slices", name);
  const content = await readFile(path, "utf8");
  const stripped = content
    .split("\n")
    .filter((line) => !new RegExp(`^${field}:`).test(line))
    .join("\n");
  await writeFile(path, stripped);
}

async function sliceFileName(f: Fixture, id: string): Promise<string> {
  const files = await readdir(join(f.projectPath, "slices"));
  const name = files.find((file) => file.startsWith(`${id}-`) || file === `${id}.md`);
  if (name === undefined) throw new Error(`slice file not found for ${id}`);
  return name;
}

async function readSlice(f: Fixture, id: string): Promise<string> {
  return readFile(join(f.projectPath, "slices", await sliceFileName(f, id)), "utf8");
}

async function runWiki(args: string[], f: Fixture): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: f.vaultRoot, ...f.env },
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
