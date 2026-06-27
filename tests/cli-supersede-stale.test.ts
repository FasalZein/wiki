import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

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

  test("preserves the target's other fields and body verbatim, re-stamps updated, and does not backfill the missing field", async () => {
    const f = await fixture();
    const old = await seedSlice(f);

    // Author extra fields + a non-trivial body + a stale `updated`, then drop the
    // now-required `summary` to simulate a target written under an older schema.
    const name = await sliceFileName(f, old);
    const path = join(f.projectPath, "slices", name);
    const seeded = matter(await readFile(path, "utf8"));
    const customBody = "# Custom heading\n\nA non-trivial body paragraph.\n\n- bullet one\n- bullet two\n";
    const authored = {
      ...seeded.data,
      group: "My Section",
      user_stories: ["US-1", "US-2"],
      updated: "2020-01-01",
    };
    delete (authored as Record<string, unknown>).summary;
    await writeFile(path, matter.stringify(customBody, authored));

    const beforeData = matter(await readFile(path, "utf8")).data;

    const result = await runWiki([
      "create", "slice",
      "--title", "Replacement slice for field-preservation",
      "--summary", "Replacement slice supersedes the stale one.",
      "--project", "wiki-v2",
      "--parent-prd", "PRD-0001",
      "--acceptance", "does the thing",
      "--supersedes", old,
    ], f);

    expect(result.exitCode).toBe(0);
    const newId = result.stdout.trim();

    const after = matter(await readFile(path, "utf8"));
    const today = new Date().toISOString().slice(0, 10);

    // Supersede fields set as expected.
    expect(after.data.status).toBe("superseded");
    expect(after.data.superseded_by).toBe(newId);
    // `updated` re-stamped to today (was 2020-01-01).
    expect(after.data.updated).toBe(today);

    // Every OTHER field preserved exactly as authored.
    for (const key of Object.keys(beforeData)) {
      if (key === "status" || key === "superseded_by" || key === "updated") continue;
      expect(after.data[key]).toEqual(beforeData[key]);
    }
    // The missing required field is NOT silently backfilled or invented.
    expect(after.data.summary).toBeUndefined();
    // Body passes through verbatim.
    expect(after.content.trimStart()).toBe(customBody.trimStart());
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
