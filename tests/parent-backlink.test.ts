import { describe, expect, test } from "bun:test";

import { buildStructure, parentBacklink, type ArtifactSpec } from "../src/artifacts/registry";

// SLICE-0114: the PRD<->slice backlink is no longer hardcoded. A child kind
// declares `parent: <kind>`; the parent declares `child_list: <field>`. On
// create, the child id is appended to the parent's child_list. These unit tests
// pin the config-driven resolution against ARBITRARY kind names (no prd/slice
// hardcode) — the full append/no-double-add/create-if-absent path is exercised
// end-to-end on the default prd/slice config in tests/cli-slice.test.ts.

const kinds: Record<string, ArtifactSpec> = {
  epic: { prefix: "EPIC", folder: "epics", dedup: false, child_list: "tasks" },
  task: { prefix: "TASK", folder: "tasks", dedup: false, parent: "epic" },
  loner: { prefix: "LONE", folder: "loners", dedup: false },
};

describe("SLICE-0114: generic config-declared parent backlink", () => {
  test("resolves a child's parent kind, parent-id field, and child_list field from config", () => {
    const structure = buildStructure(kinds);
    expect(parentBacklink(structure, "task")).toEqual({
      parentType: "epic",
      parentField: "parent_epic",
      childListField: "tasks",
    });
  });

  test("a kind with no declared parent backlinks nothing", () => {
    const structure = buildStructure(kinds);
    expect(parentBacklink(structure, "loner")).toBeUndefined();
    expect(parentBacklink(structure, "epic")).toBeUndefined();
  });

  test("a child whose parent declares no child_list backlinks nothing (config-incomplete is inert, not a throw)", () => {
    const structure = buildStructure({
      epic: { prefix: "EPIC", folder: "epics", dedup: false }, // no child_list
      task: { prefix: "TASK", folder: "tasks", dedup: false, parent: "epic" },
    });
    expect(parentBacklink(structure, "task")).toBeUndefined();
  });

  test("the default structure carries the prd<->slice relationship as config (no hardcode)", () => {
    const structure = buildStructure({
      prd: { prefix: "PRD", folder: "prds", dedup: true, child_list: "slices" },
      slice: { prefix: "SLICE", folder: "slices", dedup: true, parent: "prd" },
    });
    expect(parentBacklink(structure, "slice")).toEqual({
      parentType: "prd",
      parentField: "parent_prd",
      childListField: "slices",
    });
  });
});
