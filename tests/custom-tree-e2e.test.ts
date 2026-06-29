import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";
import { loadStructure } from "../src/artifacts/registry";
import { nextId } from "../src/artifacts/id";
import { runDoctor } from "../src/bootstrap/doctor";

// SLICE-0118: prove the section/bucket tree end-to-end on a TEMP vault whose
// wiki.json declares a custom tree the tool has never seen — a `bugs` bucket and
// a top-level `architecture` section with its own buckets. Creating into those
// buckets drives folders, prefixes, and templates entirely from config, mints
// section-prefixed ids (one id-space per section), passes doctor's structural
// validation, and surfaces each bucket's `criteria` via `wiki create <bucket>
// --help` and `wiki schema <bucket>`, all with zero code change. The real
// $HOME/Knowledge vault is never touched (mkdtemp temp vaults only).

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

// A custom tree the bundled default does not contain:
//  - `doc` reshaped to a branch section in a non-default folder (knowledge/),
//    with a `bugs` bucket the default tree has never seen (shares the DOC id-space).
//  - `decision` reshaped to a top-level `architecture` section (folder architecture/),
//    a branch with two buckets (components/boundaries) sharing the ADR id-space.
// Both reuse a bundled template (doc / decision) selected by section name — the
// folders, buckets, and criteria are all config-driven.
const customConfig = JSON.stringify({
  kinds: {
    doc: {
      prefix: "DOC",
      folder: "knowledge",
      dedup: false,
      buckets: {
        bugs: { criteria: "Defect reports: symptom, root cause, fix." },
        runbooks: { criteria: "Operational step-by-step procedures." },
      },
    },
    decision: {
      prefix: "ADR",
      folder: "architecture",
      dedup: false,
      buckets: {
        components: { criteria: "Component boundaries and responsibilities." },
        boundaries: { criteria: "System boundaries and integration seams." },
      },
    },
  },
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
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-custom-tree-"));
  tempPaths.push(vaultRoot);
  await writeFile(join(vaultRoot, "wiki.json"), customConfig);
  const proj = join(vaultRoot, "projects", project);
  for (const folder of ["knowledge", "architecture"]) {
    await mkdir(join(proj, folder), { recursive: true });
  }
  await writeFile(join(proj, "_project.md"), `---\nproject: ${project}\nrepo: /tmp/${project}\ntest_command: bun test\n---\n`);
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  prevQmd = process.env.QMD_COMMAND;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  delete process.env.QMD_COMMAND; // dedup is off on both sections; no qmd needed
  return vaultRoot;
}

describe("SLICE-0118: custom tree end-to-end", () => {
  test("creating into custom buckets drives folders/prefixes/templates from config and mints section-prefixed ids", async () => {
    const vault = await makeVault("p");

    // `bugs` is a bucket of the `doc` section (folder knowledge/) the default tree
    // has never seen. Files into knowledge/bugs/ with a DOC id and the doc template.
    const bug = await run([
      "create", "bugs",
      "--project", "p",
      "--title", "Null deref on startup",
      "--summary", "Null deref crashes the boot path.",
    ]);
    expect(bug.code).toBe(0);
    const bugPath = join(vault, "projects", "p", "knowledge", "bugs", "DOC-0001-null-deref-on-startup.md");
    const bugFile = await readFile(bugPath, "utf8");
    expect(bugFile).toContain("id: DOC-0001");
    expect(bugFile).toContain("## Content"); // doc template body sections applied

    // A second doc-section bucket shares the SAME id-space → DOC-0002, not DOC-0001.
    const runbook = await run([
      "create", "runbooks",
      "--project", "p",
      "--title", "Restart the worker pool",
      "--summary", "How to restart the worker pool safely.",
    ]);
    expect(runbook.code).toBe(0);
    const runbookPath = join(vault, "projects", "p", "knowledge", "runbooks", "DOC-0002-restart-the-worker-pool.md");
    expect(await readFile(runbookPath, "utf8")).toContain("id: DOC-0002");

    // A bucket in the OTHER section (architecture/) mints from the ADR id-space.
    const comp = await run([
      "create", "components",
      "--project", "p",
      "--title", "Search read path",
      "--summary", "The read-only search component boundary.",
    ]);
    expect(comp.code).toBe(0);
    const compPath = join(vault, "projects", "p", "architecture", "components", "ADR-0001-search-read-path.md");
    expect(await readFile(compPath, "utf8")).toContain("id: ADR-0001");
  });

  test("doctor passes structural validation against the custom tree, and nextId honors the per-section id-space", async () => {
    const vault = await makeVault("p");
    await run(["create", "bugs", "--project", "p", "--title", "First bug here", "--summary", "First bug summary here."]);
    await run(["create", "components", "--project", "p", "--title", "First component", "--summary", "First component summary."]);

    // Every artifact sits in a declared bucket subfolder, so doctor is clean.
    const result = await runDoctor(vault);
    expect(result.clean).toBe(true);

    // nextId is per-section: the doc section is at DOC-0002 (one bug filed), the
    // architecture section at ADR-0002 (one component filed) — independent spaces.
    const structure = await loadStructure(vault);
    expect(await nextId("doc", vault, "p", structure)).toBe("DOC-0002");
    expect(await nextId("decision", vault, "p", structure)).toBe("ADR-0002");
  });

  test("an undeclared folder under a custom branch section is flagged by doctor", async () => {
    const vault = await makeVault("p");
    // A folder the custom wiki.json never declared.
    await mkdir(join(vault, "projects", "p", "knowledge", "blueprints"), { recursive: true });
    await writeFile(join(vault, "projects", "p", "knowledge", "blueprints", "DOC-0009-x.md"), "---\nid: DOC-0009\n---\nx\n");

    const result = await runDoctor(vault);
    expect(result.clean).toBe(false);
    expect(result.issues.some((i) => i.message.includes("knowledge/blueprints/") && i.message.includes("not a declared bucket"))).toBe(true);
  });
});

describe("SLICE-0118: bucket criteria surfaced through the CLI", () => {
  test("`wiki create <bucket> --help` reads the bucket's criteria from the loaded structure", async () => {
    await makeVault("p");

    const help = await run(["create", "bugs", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Defect reports: symptom, root cause, fix.");
    expect(help.out).toContain("knowledge/bugs"); // config-declared folder
    expect(help.out).toContain("DOC"); // section prefix
  });

  test("`wiki schema <bucket>` lists the bucket's template fields and prints its criteria", async () => {
    await makeVault("p");

    const text = await run(["schema", "components"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("components fields:");
    expect(text.out).toContain("status"); // decision template field
    expect(text.out).toContain("criteria: Component boundaries and responsibilities.");

    const json = await run(["schema", "components", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(parsed.type).toBe("components");
    expect(parsed.criteria).toBe("Component boundaries and responsibilities.");
    expect(parsed.fields.some((f: { name: string }) => f.name === "status")).toBe(true);
  });
});
