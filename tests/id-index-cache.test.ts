import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdIndex } from "../src/artifacts/id-index";
import { createArtifact as _createArtifact } from "../src/artifacts/store";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// ADR-0045 item 5: IdIndex is the per-invocation artifact-resolution read-cache —
// one walk answers resolve + maxId + has, honest across in-process writes, while id
// allocation still re-reads under the lock so sequential creates mint distinct ids.

const tempPaths: string[] = [];
afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function createVault(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "wiki-idx-"));
  tempPaths.push(vault);
  const proj = join(vault, "projects", "p");
  for (const f of ["prds", "slices", "adrs", "handoffs", "docs"]) await mkdir(join(proj, f), { recursive: true });
  return vault;
}

const createArtifact = (input: Omit<Parameters<typeof _createArtifact>[0], "structure">) =>
  _createArtifact({ ...input, structure: DEFAULT_STRUCTURE });

describe("IdIndex read-cache", () => {
  test("one build serves resolve + maxId + has with no further disk walk", async () => {
    const vault = await createVault();
    const prds = join(vault, "projects", "p", "prds");
    await writeFile(join(prds, "PRD-0001-alpha.md"), "---\nid: PRD-0001\n---\nbody\n");
    await writeFile(join(prds, "2026-06-26-named.md"), "---\nid: PRD-0007\n---\nbody\n");

    const index = await IdIndex.build(vault, "p", DEFAULT_STRUCTURE);

    // Prove the answers come from the single build's memory, not a re-walk: delete
    // the whole vault, then assert all three questions still answer correctly.
    await rm(vault, { recursive: true, force: true });

    expect(index.resolve("PRD-0001", prds, false)).toBe(join(prds, "PRD-0001-alpha.md"));
    expect(index.resolve("PRD-0007", prds, false)).toBe(join(prds, "2026-06-26-named.md")); // date-named, via frontmatter id
    expect(index.maxId("PRD", prds, false)).toBe(7); // frontmatter id outranks the filename
    expect(index.has("PRD-0007")).toBe(true);
    expect(index.has("PRD-9999")).toBe(false);
  });

  test("write-then-read in one invocation sees the new file (update-on-write)", async () => {
    const vault = await createVault();
    const prds = join(vault, "projects", "p", "prds");
    const index = await IdIndex.build(vault, "p", DEFAULT_STRUCTURE);

    expect(index.has("PRD-0001")).toBe(false); // not on disk yet

    const path = join(prds, "PRD-0001-new.md");
    await writeFile(path, "---\nid: PRD-0001\n---\nbody\n");
    index.note("PRD-0001", path); // the write path keeps the cache honest

    expect(index.has("PRD-0001")).toBe(true);
    expect(index.resolve("PRD-0001", prds, false)).toBe(path);
  });

  test("two sequential creates in one process mint distinct ids", async () => {
    const vault = await createVault();
    const make = () =>
      createArtifact({ type: "prd", vaultRoot: vault, project: "p", fields: { title: "Sequential", summary: "A populated summary here." } });

    const first = await make();
    const second = await make(); // allocation re-reads under the lock — must see the first

    expect(first.id).toBe("PRD-0001");
    expect(second.id).toBe("PRD-0002");
  });
});
