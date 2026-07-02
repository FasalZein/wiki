import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStructure, DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// SLICE-0110 / PRD-0023: the section/bucket tree carries the kind set end-to-end.
// The bundled default is now the promoted-kinds model: ten LEAF sections (the old
// `doc` BRANCH kind was promoted into six first-class leaf kinds, each with its own
// folder + id prefix + criteria). An unconfigured vault falls back to exactly this.

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
      ["architecture", "decision", "handoff", "legacy", "notes", "prd", "research", "runbooks", "slice", "specs"],
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

  test("the six promoted knowledge kinds are LEAF sections with their own folder, prefix, and criteria", () => {
    for (const [name, folder, prefix] of [
      ["architecture", "architecture", "ARCH"],
      ["research", "research", "RES"],
      ["runbooks", "runbooks", "RUN"],
      ["specs", "specs", "SPEC"],
      ["notes", "notes", "NOTE"],
      ["legacy", "legacy", "LEG"],
    ] as const) {
      const s = section(name);
      expect(s?.tree).toBe("leaf");
      expect(s?.prefix).toBe(prefix);
      // A leaf section has exactly one self-named bucket filing into the section folder.
      expect(s?.buckets).toHaveLength(1);
      expect(s?.buckets[0]?.name).toBe(name);
      expect(s?.buckets[0]?.folder).toBe(folder);
      expect(s?.buckets[0]?.template).toBe(name);
      // The promoted kinds carry the criteria the bucket used to hold (ADR-0044).
      expect(typeof s?.buckets[0]?.criteria).toBe("string");
    }
  });

  test("flat lookups resolve every kind (no privileged kinds, methods unchanged)", () => {
    expect(DEFAULT_STRUCTURE.specFor("research")).toEqual({
      prefix: "RES",
      folder: "research",
      dedup: true,
      criteria: "External findings, investigations, comparisons, and explorations feeding a decision.",
    });
    expect(DEFAULT_STRUCTURE.specFor("handoff").dedup).toBe(false);
    expect(DEFAULT_STRUCTURE.typeForId("SLICE-0032")).toBe("slice");
    expect(DEFAULT_STRUCTURE.artifactTypeForVaultPath("projects/p/research/x.md")).toBe("research");
    expect(DEFAULT_STRUCTURE.kindForSkill("to-prd")).toBe("prd");
    expect([...DEFAULT_STRUCTURE.folders].sort()).toEqual(
      ["adrs", "architecture", "handoffs", "legacy", "notes", "prds", "research", "runbooks", "slices", "specs"],
    );
  });
});

describe("SLICE-0110: tree carried end-to-end through the loader", () => {
  test("a no-config vault falls back to the default tree (all promoted kinds present as leaves)", async () => {
    const structure = await loadStructure(await makeVault());
    expect(structure.sections.map((s) => s.name).sort()).toEqual(
      DEFAULT_STRUCTURE.sections.map((s) => s.name).sort(),
    );
    const research = structure.sections.find((s) => s.name === "research");
    expect(research?.tree).toBe("leaf");
    expect(research?.prefix).toBe("RES");
    expect(research?.buckets[0]?.folder).toBe("research");
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
