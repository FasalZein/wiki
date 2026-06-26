import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProjectIndex, writeVaultIndex } from "../src/artifacts/index-md";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wiki-indexmd-"));
  tempPaths.push(root);
  return join(root, "vault");
}

async function addArtifact(vaultRoot: string, project: string, folder: string, id: string, title: string): Promise<void> {
  const dir = join(vaultRoot, "projects", project, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${title}\n---\n# ${title}\n`);
}

describe("writeVaultIndex (SLICE-0091)", () => {
  test("lists every project and links to its roster; re-run is idempotent", async () => {
    const vaultRoot = await makeVault();
    for (const p of ["alpha", "beta"]) {
      await mkdir(join(vaultRoot, "projects", p), { recursive: true });
      await addArtifact(vaultRoot, p, "docs", "DOC-0001", "doc");
    }

    await writeVaultIndex(vaultRoot);
    const first = await readFile(join(vaultRoot, "index.md"), "utf8");
    expect(first).toContain("alpha");
    expect(first).toContain("beta");
    // links to each per-project roster
    expect(first).toContain("projects/alpha/index.md");
    expect(first).toContain("projects/beta/index.md");

    await writeVaultIndex(vaultRoot);
    const second = await readFile(join(vaultRoot, "index.md"), "utf8");
    expect(second).toBe(first); // byte-identical → idempotent
  });
});

describe("incremental roster regeneration (SLICE-0091)", () => {
  test("first run parses all files; an added artifact reparses only the new file", async () => {
    const vaultRoot = await makeVault();
    await addArtifact(vaultRoot, "alpha", "docs", "DOC-0001", "first");
    await addArtifact(vaultRoot, "alpha", "slices", "SLICE-0001", "second");

    const cold = await writeProjectIndex(vaultRoot, "alpha");
    expect(cold.parsed).toBe(2);
    expect(cold.reused).toBe(0);

    // Re-run with no changes: everything served from cache, no reparse.
    const warm = await writeProjectIndex(vaultRoot, "alpha");
    expect(warm.parsed).toBe(0);
    expect(warm.reused).toBe(2);

    // Add one artifact: only the new file is parsed, the rest reused.
    await addArtifact(vaultRoot, "alpha", "adrs", "ADR-0001", "third");
    const incremental = await writeProjectIndex(vaultRoot, "alpha");
    expect(incremental.parsed).toBe(1);
    expect(incremental.reused).toBe(2);

    const roster = await readFile(join(vaultRoot, "projects", "alpha", "index.md"), "utf8");
    expect(roster).toContain("DOC-0001");
    expect(roster).toContain("SLICE-0001");
    expect(roster).toContain("ADR-0001");
  });

  test("a removed artifact drops out of the roster on the next regen", async () => {
    const vaultRoot = await makeVault();
    await addArtifact(vaultRoot, "alpha", "docs", "DOC-0001", "keep");
    await addArtifact(vaultRoot, "alpha", "docs", "DOC-0002", "drop");
    await writeProjectIndex(vaultRoot, "alpha");

    await rm(join(vaultRoot, "projects", "alpha", "docs", "DOC-0002.md"));
    const after = await writeProjectIndex(vaultRoot, "alpha");
    expect(after.reused).toBe(1); // only the surviving file
    const roster = await readFile(join(vaultRoot, "projects", "alpha", "index.md"), "utf8");
    expect(roster).toContain("DOC-0001");
    expect(roster).not.toContain("DOC-0002");
  });
});
