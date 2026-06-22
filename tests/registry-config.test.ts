import { describe, expect, test } from "bun:test";

import { ARTIFACTS, specFor } from "../src/artifacts/registry";

describe("config-driven kind registry (wiki.json)", () => {
  test("kinds are loaded from wiki.json with prefix/folder/dedup", () => {
    // The five kinds shipped in wiki.json; the point is they come from config,
    // not a hardcoded union, so this just pins the loaded shape.
    expect(ARTIFACTS.prd).toEqual({ prefix: "PRD", folder: "prds", dedup: true });
    expect(specFor("handover").skill).toBe("handoff");
    expect(specFor("decision").skill).toBe("grill-with-docs");
  });

  test("specFor throws loudly on a kind not defined in wiki.json", () => {
    expect(() => specFor("nonexistent-kind")).toThrow(/unknown artifact kind/);
  });
});
