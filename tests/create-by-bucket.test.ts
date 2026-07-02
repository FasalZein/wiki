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

// A custom tree with a BRANCH `notes` section (folder docs/, NOTE id-space) whose
// buckets reproduce the old doc categories, driven off the existing `notes`
// template (## Content). This exercises SLICE-0112 bucket resolution — create by
// bucket name, --category subsumption — which the bundled all-leaf default no
// longer carries after the PRD-0023 doc-kind promotion.
const branchConfig = JSON.stringify({
  kinds: {
    prd: { prefix: "PRD", folder: "prds", dedup: true },
    slice: { prefix: "SLICE", folder: "slices", dedup: true },
    decision: { prefix: "ADR", folder: "adrs", dedup: true },
    handoff: { prefix: "HANDOFF", folder: "handoffs", dedup: false },
    notes: {
      prefix: "NOTE",
      folder: "docs",
      dedup: true,
      buckets: {
        architecture: { criteria: "How the system is built." },
        research: { criteria: "External findings." },
        runbooks: { criteria: "Operational how-to." },
        specs: { criteria: "Precise contracts." },
        notes: { criteria: "Catch-all." },
        legacy: { criteria: "Historical material." },
      },
    },
  },
});

async function makeVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-bucket-"));
  tempPaths.push(vaultRoot);
  await writeFile(join(vaultRoot, "wiki.json"), branchConfig);
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

    // `architecture` is a bucket of the `notes` branch section: files into
    // docs/architecture/ with a NOTE id and the notes template — no --category.
    const result = await run([
      "create", "architecture",
      "--project", "p",
      "--title", "Evidence-first architecture",
      "--summary", "Evidence-first architecture overview.",
    ]);

    expect(result.code).toBe(0);
    const path = join(vault, "projects", "p", "docs", "architecture", "NOTE-0001-evidence-first-architecture.md");
    const file = await readFile(path, "utf8");
    expect(file).toContain("id: NOTE-0001"); // section prefix
    expect(file).toContain("## Content"); // notes template body sections applied
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
    expect(result.out).toContain("notes");
  });

  test("--category is subsumed: it names a bucket of the section and files there", async () => {
    const vault = await makeVault("p");

    const result = await run([
      "create", "notes",
      "--project", "p",
      "--title", "Deploy runbook for prod",
      "--summary", "Deploy runbook for prod summary.",
      "--category", "research",
    ]);

    expect(result.code).toBe(0);
    const path = join(vault, "projects", "p", "docs", "research", "NOTE-0001-deploy-runbook-for-prod.md");
    expect(await readFile(path, "utf8")).toContain("id: NOTE-0001");
  });

  test("an unknown --category bucket errors against the loaded tree", async () => {
    await makeVault("p");
    const result = await run([
      "create", "notes",
      "--project", "p",
      "--title", "Some valid title here",
      "--summary", "Some valid summary here.",
      "--category", "blueprints",
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("unknown category: blueprints");
  });
});
