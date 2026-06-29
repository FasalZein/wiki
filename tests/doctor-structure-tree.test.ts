import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkProjectDocsStructure } from "../src/bootstrap/doctor";
import { DEFAULT_STRUCTURE, loadStructure } from "../src/artifacts/registry";

// SLICE-0113: doctor's structural validation now reads the per-vault config tree
// (PRD-0019) instead of the hardcoded DOC_CATEGORIES lock. It flags undeclared
// folders and loose files in a branch section, and never emits a fuzzy
// "wrong bucket" warning (bucket fitness is the agent's judgment).

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeVault(project: string): Promise<{ vaultRoot: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "wiki-doctor-tree-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectDir = join(vaultRoot, "projects", project);
  await mkdir(projectDir, { recursive: true });
  return { vaultRoot, projectDir };
}

describe("doctor structure-only validation (config tree)", () => {
  test("flags an undeclared folder inside a branch section", async () => {
    const { vaultRoot, projectDir } = await makeVault("p");
    await mkdir(join(projectDir, "docs", "architecture"), { recursive: true });
    await mkdir(join(projectDir, "docs", "cracking"), { recursive: true });

    const issues = await checkProjectDocsStructure(vaultRoot, "p", DEFAULT_STRUCTURE);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.type).toBe("docs-structure");
    expect(issues[0]!.message).toContain("docs/cracking/ is not a declared bucket");
  });

  test("flags a loose file sitting directly in a branch section", async () => {
    const { vaultRoot, projectDir } = await makeVault("p");
    await mkdir(join(projectDir, "docs", "notes"), { recursive: true });
    await writeFile(join(projectDir, "docs", "loose.md"), "# loose\n");

    const issues = await checkProjectDocsStructure(vaultRoot, "p", DEFAULT_STRUCTURE);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("docs/loose.md sits directly under docs/");
  });

  test("does NOT flag a valid-but-debatable bucket choice (no fuzzy warning)", async () => {
    const { vaultRoot, projectDir } = await makeVault("p");
    // a doc that an agent could argue belongs elsewhere, but the bucket is declared
    await mkdir(join(projectDir, "docs", "specs"), { recursive: true });
    await writeFile(join(projectDir, "docs", "specs", "DOC-0001-runbook-ish.md"), "# debatable\n");

    const issues = await checkProjectDocsStructure(vaultRoot, "p", DEFAULT_STRUCTURE);

    expect(issues).toHaveLength(0);
  });

  test("leaf sections holding artifacts directly are not policed for loose files", async () => {
    const { vaultRoot, projectDir } = await makeVault("p");
    await mkdir(join(projectDir, "prds"), { recursive: true });
    await writeFile(join(projectDir, "prds", "PRD-0001.md"), "# prd\n");

    const issues = await checkProjectDocsStructure(vaultRoot, "p", DEFAULT_STRUCTURE);

    expect(issues).toHaveLength(0);
  });

  test("validates against a custom config tree, not the default categories", async () => {
    const { vaultRoot, projectDir } = await makeVault("p");
    await writeFile(
      join(vaultRoot, "wiki.json"),
      JSON.stringify({
        kinds: {
          prd: { prefix: "PRD", folder: "prds", dedup: true },
          slice: { prefix: "SLICE", folder: "slices", dedup: true },
          decision: { prefix: "ADR", folder: "adrs", dedup: true },
          doc: { prefix: "DOC", folder: "docs", dedup: true },
          handoff: { prefix: "HANDOFF", folder: "handoffs", dedup: false },
          design: {
            prefix: "DSN",
            folder: "design",
            dedup: false,
            buckets: { wireframes: { criteria: "low-fi" }, mockups: { criteria: "hi-fi" } },
          },
        },
      }),
    );
    const structure = await loadStructure(vaultRoot);

    // a declared custom bucket is fine
    await mkdir(join(projectDir, "design", "wireframes"), { recursive: true });
    // "architecture" is a default doc bucket but NOT a design bucket — flagged under design
    await mkdir(join(projectDir, "design", "architecture"), { recursive: true });

    const issues = await checkProjectDocsStructure(vaultRoot, "p", structure);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("design/architecture/ is not a declared bucket of section 'design'");
  });
});
