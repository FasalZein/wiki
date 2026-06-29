import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStructure, DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// SLICE-0110: the section/bucket tree is a walking skeleton — the type and
// loader carry the tree end-to-end and validate it; create/doctor/relocation
// behavior changes land in later slices. The bundled default tree must
// reproduce today's five kinds + six doc categories exactly so an unconfigured
// vault is byte-for-byte unaffected.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeVault(wikiJson?: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-tree-"));
  tempPaths.push(vaultRoot);
  if (wikiJson !== undefined) await writeFile(join(vaultRoot, "wiki.json"), wikiJson);
  return vaultRoot;
}

const section = (name: string) => DEFAULT_STRUCTURE.sections.find((s) => s.name === name);

describe("SLICE-0110: bundled default section/bucket tree", () => {
  test("the default exposes one section per kind", () => {
    expect(DEFAULT_STRUCTURE.sections.map((s) => s.name).sort()).toEqual(
      ["decision", "doc", "handoff", "prd", "slice"],
    );
  });

  test("the four artifact kinds are LEAF sections with one self-named bucket in the section folder", () => {
    for (const [name, folder, prefix] of [
      ["prd", "prds", "PRD"],
      ["slice", "slices", "SLICE"],
      ["decision", "adrs", "ADR"],
      ["handoff", "handoffs", "HANDOFF"],
    ] as const) {
      const s = section(name);
      expect(s?.tree).toBe("leaf");
      expect(s?.prefix).toBe(prefix);
      expect(s?.buckets).toEqual([{ name, folder, template: name }]);
    }
  });

  test("doc is the one BRANCH section: six buckets reproducing the locked doc categories, sharing the DOC id-space", () => {
    const doc = section("doc");
    expect(doc?.tree).toBe("branch");
    expect(doc?.prefix).toBe("DOC");
    expect(doc?.buckets.map((b) => b.name)).toEqual([
      "architecture",
      "research",
      "runbooks",
      "specs",
      "notes",
      "legacy",
    ]);
    // Each bucket files into docs/<category>/, shares the DOC prefix, uses the doc template, and carries criteria.
    for (const bucket of doc?.buckets ?? []) {
      expect(bucket.folder).toBe(`docs/${bucket.name}`);
      expect(bucket.template).toBe("doc");
      expect(typeof bucket.criteria).toBe("string");
    }
  });

  test("existing flat lookups are byte-identical (no privileged kinds, methods unchanged)", () => {
    expect(DEFAULT_STRUCTURE.specFor("doc")).toEqual({ prefix: "DOC", folder: "docs", dedup: true });
    expect(DEFAULT_STRUCTURE.specFor("handoff").dedup).toBe(false);
    expect(DEFAULT_STRUCTURE.typeForId("SLICE-0032")).toBe("slice");
    expect(DEFAULT_STRUCTURE.artifactTypeForVaultPath("projects/p/docs/x.md")).toBe("doc");
    expect(DEFAULT_STRUCTURE.kindForSkill("to-prd")).toBe("prd");
    expect([...DEFAULT_STRUCTURE.folders].sort()).toEqual(["adrs", "docs", "handoffs", "prds", "slices"]);
  });
});

describe("SLICE-0110: tree carried end-to-end through the loader", () => {
  test("a no-config vault falls back to the default tree (six doc buckets present)", async () => {
    const structure = await loadStructure(await makeVault());
    const doc = structure.sections.find((s) => s.name === "doc");
    expect(doc?.tree).toBe("branch");
    expect(doc?.buckets.map((b) => b.name)).toEqual(DEFAULT_STRUCTURE.sections.find((s) => s.name === "doc")?.buckets.map((b) => b.name));
  });

  test("a custom branch section declared in wiki.json becomes a tree with its buckets", async () => {
    const vault = await makeVault(JSON.stringify({
      kinds: {
        doc: {
          prefix: "DOC",
          folder: "docs",
          dedup: true,
          buckets: {
            bugs: { criteria: "Defect reports." },
            architecture: { criteria: "How it is built." },
          },
        },
        prd: { prefix: "PRD", folder: "prds", dedup: true },
      },
    }));
    const structure = await loadStructure(vault);
    const doc = structure.sections.find((s) => s.name === "doc");
    expect(doc?.tree).toBe("branch");
    expect(doc?.buckets).toEqual([
      { name: "bugs", folder: "docs/bugs", template: "doc", criteria: "Defect reports." },
      { name: "architecture", folder: "docs/architecture", template: "doc", criteria: "How it is built." },
    ]);
    // prd with no declared buckets stays a leaf.
    expect(structure.sections.find((s) => s.name === "prd")?.tree).toBe("leaf");
  });
});

describe("SLICE-0110: a malformed tree hard-errors at load (writing nothing)", () => {
  test("a duplicate bucket name across the tree fails loudly", async () => {
    const vault = await makeVault(JSON.stringify({
      kinds: {
        doc: { prefix: "DOC", folder: "docs", dedup: true, buckets: { specs: {}, notes: {} } },
        // 'notes' also a leaf section name collides with the doc bucket 'notes'.
        notes: { prefix: "NOTE", folder: "notes", dedup: false },
      },
    }));
    await expect(loadStructure(vault)).rejects.toThrow(/duplicate bucket name 'notes'/);
  });

  test("an empty buckets object (neither branch nor leaf) fails loudly", async () => {
    const vault = await makeVault(JSON.stringify({
      kinds: { doc: { prefix: "DOC", folder: "docs", dedup: true, buckets: {} } },
    }));
    await expect(loadStructure(vault)).rejects.toThrow(/empty 'buckets'/);
  });

  test("a bucket declaring nested buckets (a branch-and-leaf node) fails loudly", async () => {
    const vault = await makeVault(JSON.stringify({
      kinds: {
        doc: {
          prefix: "DOC",
          folder: "docs",
          dedup: true,
          buckets: { architecture: { buckets: { deeper: {} } } },
        },
      },
    }));
    await expect(loadStructure(vault)).rejects.toThrow(/nested 'buckets'/);
  });
});
