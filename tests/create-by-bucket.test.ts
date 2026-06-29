import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";

// SLICE-0112: `wiki create <name>` resolves <name> to its section (prefix +
// id-space) and the bucket's template, where <name> is a bucket inside a branch
// section or a leaf section. The artifact lands in the bucket folder with a
// section-prefixed id minted per-section. An unknown name errors clearly. This
// subsumes the --category flag, which now names a bucket validated against the
// loaded tree rather than the old DocCategory enum.

const tempPaths: string[] = [];
let prevVaultRoot: string | undefined;
let prevQmd: string | undefined;

afterEach(async () => {
  if (prevVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = prevVaultRoot;
  if (prevQmd === undefined) delete process.env.QMD_COMMAND;
  else process.env.QMD_COMMAND = prevQmd;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function capture(): { restore: () => void; out: () => string } {
  const log = console.log;
  const err = console.error;
  let buffer = "";
  const sink = (...args: unknown[]) => { buffer += args.map(String).join(" ") + "\n"; };
  console.log = sink;
  console.error = sink;
  return { restore: () => { console.log = log; console.error = err; }, out: () => buffer };
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cap = capture();
  let code = 0;
  try {
    code = (await dispatch(args)).code;
  } finally {
    cap.restore();
  }
  return { code, out: cap.out() };
}

async function makeVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-bucket-"));
  tempPaths.push(vaultRoot);
  const proj = join(vaultRoot, "projects", project);
  for (const folder of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(proj, folder), { recursive: true });
  }
  await writeFile(join(proj, "_project.md"), `---\nproject: ${project}\nrepo: /tmp/${project}\ntest_command: bun test\n---\n`);
  // Hermetic no-op qmd so the advisory dedup gate doesn't ride the real binary.
  const qmd = join(vaultRoot, "fake-qmd");
  await writeFile(qmd, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  prevQmd = process.env.QMD_COMMAND;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  process.env.QMD_COMMAND = qmd;
  return vaultRoot;
}

describe("SLICE-0112: create by bucket/leaf name", () => {
  test("create <branch-bucket> files into the bucket folder with a section-prefixed id and the section template", async () => {
    const vault = await makeVault("p");

    // `architecture` is a bucket of the `doc` branch section: files into
    // docs/architecture/ with a DOC id and the doc template — no --category.
    const result = await run([
      "create", "architecture",
      "--project", "p",
      "--title", "Evidence-first architecture",
      "--summary", "Evidence-first architecture overview.",
    ]);

    expect(result.code).toBe(0);
    const path = join(vault, "projects", "p", "docs", "architecture", "DOC-0001-evidence-first-architecture.md");
    const file = await readFile(path, "utf8");
    expect(file).toContain("id: DOC-0001"); // section prefix
    expect(file).toContain("## Content"); // doc template body sections applied
  });

  test("create <leaf-name> still files straight into the section folder", async () => {
    const vault = await makeVault("p");

    const result = await run([
      "create", "prd",
      "--project", "p",
      "--title", "Some new requirement doc",
      "--summary", "Some new requirement doc summary.",
    ]);

    expect(result.code).toBe(0);
    const path = join(vault, "projects", "p", "prds", "PRD-0001-some-new-requirement-doc.md");
    expect(await readFile(path, "utf8")).toContain("id: PRD-0001");
  });

  test("an unknown name errors clearly and lists the kinds", async () => {
    await makeVault("p");
    const result = await run(["create", "blueprints", "--project", "p", "--title", "x", "--summary", "xxxxxxxxxx"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("unknown artifact type: blueprints");
    expect(result.out).toContain("doc");
  });

  test("--category is subsumed: it names a bucket of the section and files there", async () => {
    const vault = await makeVault("p");

    const result = await run([
      "create", "doc",
      "--project", "p",
      "--title", "Deploy runbook for prod",
      "--summary", "Deploy runbook for prod summary.",
      "--category", "research",
    ]);

    expect(result.code).toBe(0);
    const path = join(vault, "projects", "p", "docs", "research", "DOC-0001-deploy-runbook-for-prod.md");
    expect(await readFile(path, "utf8")).toContain("id: DOC-0001");
  });

  test("an unknown --category bucket errors against the loaded tree", async () => {
    await makeVault("p");
    const result = await run([
      "create", "doc",
      "--project", "p",
      "--title", "Some valid title here",
      "--summary", "Some valid summary here.",
      "--category", "blueprints",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("unknown category: blueprints");
  });
});
