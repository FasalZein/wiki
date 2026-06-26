import { describe, expect, test } from "bun:test";

import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

const { kinds } = DEFAULT_STRUCTURE;
const specFor = (type: string) => DEFAULT_STRUCTURE.specFor(type);

describe("config-driven kind registry (wiki.json)", () => {
  test("kinds are loaded from wiki.json with prefix/folder/dedup", () => {
    // The five kinds shipped in wiki.json; the point is they come from config,
    // not a hardcoded union, so this just pins the loaded shape.
    expect(kinds.prd).toEqual({ prefix: "PRD", folder: "prds", dedup: true, skill: "to-prd" });
    expect(kinds.doc).toEqual({ prefix: "DOC", folder: "docs", dedup: true }); // no authoring skill
    expect(specFor("handoff").skill).toBe("handoff");
    expect(specFor("decision").skill).toBe("grill-with-docs");
    expect(specFor("slice").skill).toBe("to-slices");
  });

  test("specFor throws loudly on a kind not defined in wiki.json", () => {
    expect(() => specFor("nonexistent-kind")).toThrow(/unknown artifact kind/);
  });
});
