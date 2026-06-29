import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextId } from "../src/artifacts/id";
import { loadStructure } from "../src/artifacts/registry";

// SLICE-0111: id allocation moved from per-kind to per-SECTION. All buckets
// under one branch section draw from a single increasing id-space keyed on the
// section's prefix, so an intra-section move can later preserve identity. Under
// the bundled default tree this preserves today's per-kind sequences exactly.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeVault(wikiJson?: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-sectionid-"));
  tempPaths.push(vaultRoot);
  if (wikiJson !== undefined) await writeFile(join(vaultRoot, "wiki.json"), wikiJson);
  return vaultRoot;
}

describe("SLICE-0111: per-section id allocation on a custom multi-bucket tree", () => {
  // A branch section "feature" (prefix FEAT) with two buckets that file into
  // separate subfolders but share one id-space.
  const customConfig = JSON.stringify({
    kinds: {
      feature: {
        prefix: "FEAT",
        folder: "features",
        dedup: false,
        buckets: { alpha: {}, beta: {} },
      },
    },
  });

  test("buckets in one section share one increasing id-space (one counter, not two)", async () => {
    const vault = await makeVault(customConfig);
    const structure = await loadStructure(vault);
    const features = join(vault, "projects", "p", "features");
    await mkdir(join(features, "alpha"), { recursive: true });
    await mkdir(join(features, "beta"), { recursive: true });
    // Highest id lives in the beta bucket; allocation must see across buckets.
    await writeFile(join(features, "alpha", "FEAT-0001-a.md"), "---\nid: FEAT-0001\n---\n");
    await writeFile(join(features, "beta", "FEAT-0002-b.md"), "---\nid: FEAT-0002\n---\n");

    // Next id is section-wide highest + 1 with the shared section prefix, no
    // matter which bucket name we resolve the section through.
    expect(await nextId("feature", vault, "p", structure)).toBe("FEAT-0003");
  });

  test("an empty multi-bucket section starts at 0001", async () => {
    const vault = await makeVault(customConfig);
    const structure = await loadStructure(vault);
    await mkdir(join(vault, "projects", "p", "features", "alpha"), { recursive: true });
    expect(await nextId("feature", vault, "p", structure)).toBe("FEAT-0001");
  });
});

describe("SLICE-0111: default-tree regression — existing kinds keep their id sequence", () => {
  async function makeProject(vault: string, project: string): Promise<void> {
    for (const folder of ["prds", "slices", "adrs", "handoffs", "docs"]) {
      await mkdir(join(vault, "projects", project, folder), { recursive: true });
    }
  }

  test("leaf kinds (prd/slice/adr) keep their flat per-kind sequence", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    await makeProject(vault, "p");
    const prds = join(vault, "projects", "p", "prds");
    await writeFile(join(prds, "PRD-0001.md"), "---\nid: PRD-0001\n---\n");
    await writeFile(join(prds, "PRD-0002.md"), "---\nid: PRD-0002\n---\n");

    expect(await nextId("prd", vault, "p", structure)).toBe("PRD-0003");
    expect(await nextId("slice", vault, "p", structure)).toBe("SLICE-0001");
  });

  test("doc (the default branch section) stays globally unique across its category buckets", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    await makeProject(vault, "p");
    const docs = join(vault, "projects", "p", "docs");
    await mkdir(join(docs, "research"), { recursive: true });
    await mkdir(join(docs, "runbooks"), { recursive: true });
    await writeFile(join(docs, "research", "DOC-0004-a.md"), "---\nid: DOC-0004\n---\n");
    await writeFile(join(docs, "runbooks", "DOC-0009-b.md"), "---\nid: DOC-0009\n---\n");

    expect(await nextId("doc", vault, "p", structure)).toBe("DOC-0010");
  });
});
