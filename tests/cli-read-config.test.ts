import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";
import { writeProjectIndex } from "../src/artifacts/index-md";
import { loadStructure } from "../src/artifacts/registry";

let vaultRoot: string;
let prevVaultRoot: string | undefined;

// A custom config that routes prd into a non-default folder with a non-default
// prefix; the read path must infer type from THIS folder/prefix, not the bundled
// default. The other kinds keep default folders so assertProjectStructure passes.
const CUSTOM_WIKI_JSON = JSON.stringify({
  kinds: {
    prd: { prefix: "REQ", folder: "requirements", dedup: true },
    slice: { prefix: "SLICE", folder: "slices", dedup: true },
    decision: { prefix: "ADR", folder: "adrs", dedup: false },
    doc: { prefix: "DOC", folder: "docs", dedup: false },
    handoff: { prefix: "HANDOFF", folder: "handoffs", dedup: false },
  },
});

function capture(): { restore: () => void; out: () => string; err: () => string } {
  const ol = console.log;
  const oe = console.error;
  let o = "";
  let e = "";
  console.log = (...a: unknown[]) => { o += a.map(String).join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { e += a.map(String).join(" ") + "\n"; };
  return { restore: () => { console.log = ol; console.error = oe; }, out: () => o, err: () => e };
}

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "wiki-readcfg-"));
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
});

afterEach(async () => {
  if (prevVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = prevVaultRoot;
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("validate honors the per-vault Structure (read path)", () => {
  test("a custom-config vault infers the artifact type from the configured folder", async () => {
    await writeFile(join(vaultRoot, "wiki.json"), CUSTOM_WIKI_JSON, "utf8");
    const reqDir = join(vaultRoot, "projects", "p", "requirements");
    await mkdir(reqDir, { recursive: true });
    const file = join(reqDir, "REQ-0001-x.md");
    await writeFile(file, "---\nid: REQ-0001\n---\n# x\n", "utf8");

    const cap = capture();
    const result = await dispatch(["validate", file]);
    cap.restore();

    // The per-vault config maps requirements/ -> prd, so validate infers prd and
    // runs schema validation (failing on missing fields) rather than bailing with
    // "cannot infer artifact type from path".
    expect(cap.err()).not.toContain("cannot infer artifact type");
    expect(result.code).toBe(1); // incomplete REQ-0001 fails schema, but the TYPE was inferred
  });

  test("a default (no-config) vault does NOT recognize the custom folder", async () => {
    const reqDir = join(vaultRoot, "projects", "p", "requirements");
    await mkdir(reqDir, { recursive: true });
    const file = join(reqDir, "REQ-0001-x.md");
    await writeFile(file, "---\nid: REQ-0001\n---\n# x\n", "utf8");

    const cap = capture();
    const result = await dispatch(["validate", file]);
    cap.restore();

    // No wiki.json: requirements/ is not a known folder, so type inference fails.
    expect(cap.err()).toContain("cannot infer artifact type");
    expect(result.code).toBe(1);
  });
});

describe("index-md honors the per-vault Structure (read path)", () => {
  test("a custom prefix is classified into the roster; default structure skips it", async () => {
    await writeFile(join(vaultRoot, "wiki.json"), CUSTOM_WIKI_JSON, "utf8");
    // Two projects so each gets its own .index-cache.json — the cache is keyed by
    // path+mtime, so reusing one project would serve the first structure's parse.
    for (const proj of ["pa", "pb"]) {
      const reqDir = join(vaultRoot, "projects", proj, "requirements");
      await mkdir(reqDir, { recursive: true });
      await writeFile(join(reqDir, "REQ-0001-x.md"), "---\nid: REQ-0001\ntitle: A requirement\n---\n# A requirement\n", "utf8");
    }

    const custom = await loadStructure(vaultRoot);
    await writeProjectIndex(vaultRoot, "pa", custom);
    const indexWithCustom = await Bun.file(join(vaultRoot, "projects", "pa", "index.md")).text();
    expect(indexWithCustom).toContain("[[REQ-0001]] A requirement");

    // Same artifact, but the bundled default structure does not know the REQ
    // prefix, so typeForId returns undefined — it is kept OUT of the roster body but
    // surfaced in the Unrecognized-kind trailer (F7), never silently dropped.
    const { DEFAULT_STRUCTURE } = await import("../src/artifacts/registry");
    await writeProjectIndex(vaultRoot, "pb", DEFAULT_STRUCTURE);
    const indexWithDefault = await Bun.file(join(vaultRoot, "projects", "pb", "index.md")).text();
    expect(indexWithDefault).not.toContain("[[REQ-0001]]"); // not a roster row
    expect(indexWithDefault).toContain("## Unrecognized kind");
    expect(indexWithDefault).toContain("requirements/REQ-0001-x.md (id REQ-0001 — prefix not a registered kind)");
  });
});
