import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("mutation verbs", () => {
  test("wiki set changes a field with schema validation and --json output", async () => {
    const f = await fixture();
    const slice = await seedSlice(f);

    const result = await runWiki(["set", slice, "status", "blocked", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: slice, field: "status", value: "blocked" });
    expect(await readSlice(f, slice)).toContain("status: blocked");
  });

  test("wiki set rejects an invalid enum and reports it in --json", async () => {
    const f = await fixture();
    const slice = await seedSlice(f);

    const result = await runWiki(["set", slice, "status", "nope", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).not.toBe(0);
    const err = JSON.parse(result.stderr);
    expect(err.field).toBe("status");
    expect(err.error).toContain("invalid enum");
  });

  test("wiki set coerces booleans from the schema", async () => {
    const f = await fixture();
    const slice = await seedSlice(f);

    const result = await runWiki(["set", slice, "tdd_exempt", "true", "--project", "wiki-v2"], f);

    expect(result.exitCode).toBe(0);
    expect(await readSlice(f, slice)).toContain("tdd_exempt: true");
  });

  test("wiki block wraps bare ids as wikilinks with no comma corruption", async () => {
    const f = await fixture();
    const slice = await seedSlice(f);

    const result = await runWiki(["block", slice, "--on", "SLICE-0030", "--on", "SLICE-0031", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).blocked_by).toEqual(["[[SLICE-0030]]", "[[SLICE-0031]]"]);
    const body = await readSlice(f, slice);
    expect(body).toContain("[[SLICE-0030]]");
    expect(body).toContain("[[SLICE-0031]]");
  });

  test("wiki supersede records superseded_by and status standalone", async () => {
    const f = await fixture();
    const oldSlice = await seedSlice(f);
    const newSlice = await seedSlice(f);

    const result = await runWiki(["supersede", oldSlice, "--by", newSlice, "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    const body = await readSlice(f, oldSlice);
    expect(body).toContain("status: superseded");
    expect(body).toContain(`superseded_by: ${newSlice}`);
  });

  test("wiki supersede fails cleanly when the superseding id is missing", async () => {
    const f = await fixture();
    const oldSlice = await seedSlice(f);

    const result = await runWiki(["supersede", oldSlice, "--by", "SLICE-9999", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toContain("not found");
  });

  test("wiki path prints the artifact path, and --json wraps it", async () => {
    const f = await fixture();
    const slice = await seedSlice(f);

    const result = await runWiki(["path", slice, "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).path).toContain(`${slice}-`);
  });

  test("wiki retitle changes a non-doc artifact's title/slug, preserving id and links", async () => {
    const f = await fixture();
    const slice = await seedSlice(f);

    const result = await runWiki(["retitle", slice, "--title", "A brand new title", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).id).toBe(slice); // id preserved
    const files = await readdir(join(f.projectPath, "slices"));
    // re-slugged filename keeps the id prefix
    expect(files.some((file) => file.startsWith(`${slice}-`) && file.includes("brand-new-title"))).toBe(true);
    expect(await readSlice(f, slice)).toContain("title: A brand new title");
  });

  test("wiki delete refuses when an inbound reference exists and lists the referrers", async () => {
    const f = await fixture();
    const target = await seedSlice(f);
    const referrer = await seedSlice(f);
    // make `referrer` point at `target`
    expect((await runWiki(["block", referrer, "--on", target, "--project", "wiki-v2"], f)).exitCode).toBe(0);

    const result = await runWiki(["delete", target, "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).not.toBe(0);
    const err = JSON.parse(result.stderr);
    expect(err.error).toContain("inbound");
    expect(err.inbound).toContain(referrer);
    // file still present
    const files = await readdir(join(f.projectPath, "slices"));
    expect(files.some((file) => file.startsWith(`${target}-`))).toBe(true);
  });

  test("wiki delete --force removes an artifact despite inbound references", async () => {
    const f = await fixture();
    const target = await seedSlice(f);
    const referrer = await seedSlice(f);
    expect((await runWiki(["block", referrer, "--on", target, "--project", "wiki-v2"], f)).exitCode).toBe(0);

    const result = await runWiki(["delete", target, "--force", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).id).toBe(target);
    const files = await readdir(join(f.projectPath, "slices"));
    expect(files.some((file) => file.startsWith(`${target}-`))).toBe(false);
  });

  test("wiki delete removes an unreferenced artifact without --force", async () => {
    const f = await fixture();
    // a standalone slice nothing links to (seedSlice's parent-PRD backlink would count as inbound)
    await writeFile(
      join(f.projectPath, "slices", "SLICE-0099.md"),
      "---\nid: SLICE-0099\ntitle: Lonely slice\nsummary: No links.\nstatus: planned\n---\nbody\n",
    );

    const result = await runWiki(["delete", "SLICE-0099", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    const files = await readdir(join(f.projectPath, "slices"));
    expect(files.some((file) => file.startsWith("SLICE-0099"))).toBe(false);
  });

  test("wiki schema slice lists the enum including superseded (--json)", async () => {
    const f = await fixture();

    const result = await runWiki(["schema", "slice", "--json"], f);

    expect(result.exitCode).toBe(0);
    const status = JSON.parse(result.stdout).fields.find((field: { name: string }) => field.name === "status");
    expect(status.values).toContain("superseded");
  });
});

type Fixture = { vaultRoot: string; projectPath: string; env: Record<string, string> };

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-mutate-"));
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
    const prd = await runWiki(["create", "prd", "--title", "Parent PRD for mutate tests", "--summary", "Parent PRD for mutate tests.", "--project", "wiki-v2", "--force-new", "Seeding a parent PRD for the mutation verb tests"], f);
    expect(prd.exitCode).toBe(0);
  }
  const result = await runWiki(["create", "slice", "--title", "Slice under test for mutation", "--summary", "Slice under test for mutation.", "--project", "wiki-v2", "--parent-prd", "PRD-0001", "--acceptance", "does the thing", "--force-new", "Seeding a slice to mutate in the verb tests"], f);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

async function readSlice(f: Fixture, id: string): Promise<string> {
  const files = await readdir(join(f.projectPath, "slices"));
  const name = files.find((file) => file.startsWith(`${id}-`) || file === `${id}.md`);
  return readFile(join(f.projectPath, "slices", name!), "utf8");
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
