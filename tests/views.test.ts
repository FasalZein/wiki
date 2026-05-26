import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import {
  generateSlicesBase,
  generatePRDsBase,
  generateDecisionsBase,
  deployViews,
} from "../src/bootstrap/views";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-views-"));
  tempPaths.push(dir);
  return dir;
}

describe("generateSlicesBase", () => {
  test("returns valid YAML with correct folder filter", () => {
    const result = generateSlicesBase("projects/wiki-v2");
    expect(result).toContain('file.inFolder("projects/wiki-v2/slices")');
  });

  test("has 3 views: All Slices, Active, By PRD", () => {
    const result = generateSlicesBase("projects/wiki-v2");
    expect(result).toContain("All Slices");
    expect(result).toContain("Active");
    expect(result).toContain("By PRD");
    // Count view entries
    const viewMatches = result.match(/- type: table/g);
    expect(viewMatches).toHaveLength(3);
  });
});

describe("generatePRDsBase", () => {
  test("has correct folder filter and 2 views", () => {
    const result = generatePRDsBase("projects/my-project");
    expect(result).toContain('file.inFolder("projects/my-project/prds")');
    const viewMatches = result.match(/- type: table/g);
    expect(viewMatches).toHaveLength(2);
    expect(result).toContain("All PRDs");
    expect(result).toContain("Active");
  });
});

describe("generateDecisionsBase", () => {
  test("has correct folder filter and 1 view", () => {
    const result = generateDecisionsBase("projects/decisions-test");
    expect(result).toContain('file.inFolder("projects/decisions-test/adrs")');
    const viewMatches = result.match(/- type: table/g);
    expect(viewMatches).toHaveLength(1);
    expect(result).toContain("All Decisions");
  });
});

describe("all generators", () => {
  test("include file.name in every view order", () => {
    const slices = generateSlicesBase("projects/x");
    const prds = generatePRDsBase("projects/x");
    const decisions = generateDecisionsBase("projects/x");

    // Parse back and check each view has file.name in order
    const slicesParsed = yaml.load(slices) as { views: { order: string[] }[] };
    const prdsParsed = yaml.load(prds) as { views: { order: string[] }[] };
    const decisionsParsed = yaml.load(decisions) as { views: { order: string[] }[] };

    for (const view of slicesParsed.views) {
      expect(view.order).toContain("file.name");
    }
    for (const view of prdsParsed.views) {
      expect(view.order).toContain("file.name");
    }
    for (const view of decisionsParsed.views) {
      expect(view.order).toContain("file.name");
    }
  });
});

describe("deployViews", () => {
  test("writes 3 files to the correct paths", async () => {
    const vaultRoot = await makeTempDir();
    const written = await deployViews(vaultRoot, "wiki-v2");

    expect(written).toHaveLength(3);
    // All paths should be under projects/wiki-v2/
    for (const p of written) {
      expect(p).toContain(join("projects", "wiki-v2"));
    }
    // Verify files exist on disk
    for (const p of written) {
      const content = await readFile(p, "utf8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test("creates files with .base extension", async () => {
    const vaultRoot = await makeTempDir();
    const written = await deployViews(vaultRoot, "wiki-v2");

    for (const p of written) {
      expect(p).toEndWith(".base");
    }
  });
});

describe("YAML round-trip", () => {
  test("generated YAML can be parsed back to matching structure", () => {
    const slicesYaml = generateSlicesBase("projects/wiki-v2");
    const parsed = yaml.load(slicesYaml) as Record<string, unknown>;

    // Top-level keys exist
    expect(parsed).toHaveProperty("filters");
    expect(parsed).toHaveProperty("properties");
    expect(parsed).toHaveProperty("views");

    // filters.and is an array
    const filters = parsed.filters as { and: unknown[] };
    expect(Array.isArray(filters.and)).toBe(true);

    // views is an array of objects with type, name, order
    const views = parsed.views as { type: string; name: string; order: string[] }[];
    expect(views.length).toBeGreaterThanOrEqual(1);
    for (const v of views) {
      expect(v).toHaveProperty("type");
      expect(v).toHaveProperty("name");
      expect(v).toHaveProperty("order");
    }
  });
});

describe("path format", () => {
  test("folder paths use forward slashes", () => {
    // Even on Windows, Obsidian vault paths use forward slashes
    const slices = generateSlicesBase("projects\\back-slash");
    // The folder filter should NOT contain backslashes
    expect(slices).not.toContain("\\");
    expect(slices).toContain('file.inFolder("projects/back-slash/slices")');
  });
});
