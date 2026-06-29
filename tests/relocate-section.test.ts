import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readArtifact, relocateArtifact } from "../src/artifacts/store";
import { loadStructure } from "../src/artifacts/registry";

// SLICE-0115: relocateArtifact is now the section-agnostic "move to bucket".
// A same-section move keeps the id (inbound [[id]] links stay resolvable
// because the section owns the id-space); a cross-section move re-mints the id
// in the target section's id-space. Driven entirely from a custom wiki.json tree
// against a TEMP vault — the real $HOME/Knowledge vault is never touched.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// A branch section "notebook" (prefix NOTE) with two buckets sharing its id-space,
// plus a separate leaf section "archive" (prefix ARCH) to move across.
const customConfig = JSON.stringify({
  kinds: {
    notebook: { prefix: "NOTE", folder: "notebooks", dedup: false, buckets: { draft: {}, final: {} } },
    archive: { prefix: "ARCH", folder: "archive", dedup: false },
  },
});

async function makeVault(): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-relocate-"));
  tempPaths.push(vaultRoot);
  await writeFile(join(vaultRoot, "wiki.json"), customConfig);
  return vaultRoot;
}

async function seedNote(vault: string, bucket: string, id: string): Promise<void> {
  const dir = join(vault, "projects", "p", "notebooks", bucket);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}-some-note.md`),
    `---\nid: ${id}\naliases:\n  - ${id}\ntitle: Some note\n---\nBody stays put.\n`,
  );
}

describe("SLICE-0115: same-section move preserves identity", () => {
  test("moving between buckets of one section keeps the id and stays resolvable by id", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    await seedNote(vault, "draft", "NOTE-0001");

    const moved = await relocateArtifact(
      { type: "notebook", vaultRoot: vault, project: "p", id: "NOTE-0001", bucket: "final" },
      structure,
    );

    // Id preserved; file now under the target bucket folder.
    expect(moved.id).toBe("NOTE-0001");
    expect(moved.path).toContain(join("notebooks", "final"));
    // Old bucket file is gone.
    const oldPath = join(vault, "projects", "p", "notebooks", "draft", "NOTE-0001-some-note.md");
    expect(await Bun.file(oldPath).exists()).toBe(false);
    // [[NOTE-0001]] still resolves: an id-based read finds the relocated file.
    const read = await readArtifact({ type: "notebook", vaultRoot: vault, project: "p", id: "NOTE-0001" }, structure);
    expect(read.id).toBe("NOTE-0001");
    expect(read.body.trim()).toBe("Body stays put.");
  });

  test("a pure retitle (no bucket) keeps the file in its current folder, id preserved", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    await seedNote(vault, "draft", "NOTE-0001");

    const moved = await relocateArtifact(
      { type: "notebook", vaultRoot: vault, project: "p", id: "NOTE-0001", title: "Renamed note" },
      structure,
    );

    expect(moved.id).toBe("NOTE-0001");
    expect(moved.path).toContain(join("notebooks", "draft"));
    expect(moved.path).toContain("renamed-note.md");
    expect(moved.fields.title).toBe("Renamed note");
  });
});

describe("SLICE-0115: cross-section move re-mints identity", () => {
  test("moving to a bucket in another section re-mints the id in the target id-space", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    await seedNote(vault, "draft", "NOTE-0001");
    // Pre-seed an existing archive artifact so the re-mint draws the next id.
    await mkdir(join(vault, "projects", "p", "archive"), { recursive: true });
    await writeFile(join(vault, "projects", "p", "archive", "ARCH-0007-old.md"), "---\nid: ARCH-0007\n---\n");

    const moved = await relocateArtifact(
      { type: "notebook", vaultRoot: vault, project: "p", id: "NOTE-0001", bucket: "archive" },
      structure,
    );

    // Re-minted into the archive section's id-space (highest + 1), not NOTE-0001.
    expect(moved.id).toBe("ARCH-0008");
    expect(moved.path).toContain("archive");
    expect(moved.fields.id).toBe("ARCH-0008");
    // The new id is in aliases; the old id no longer is.
    expect(moved.fields.aliases).toEqual(["ARCH-0008"]);
    // The old source file is removed.
    const oldPath = join(vault, "projects", "p", "notebooks", "draft", "NOTE-0001-some-note.md");
    expect(await Bun.file(oldPath).exists()).toBe(false);
    // The re-minted file resolves by its NEW id, body passes through verbatim.
    const read = await readArtifact({ type: "archive", vaultRoot: vault, project: "p", id: "ARCH-0008" }, structure);
    expect(read.id).toBe("ARCH-0008");
    expect(read.body.trim()).toBe("Body stays put.");
  });

  test("unknown bucket errors clearly", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    await seedNote(vault, "draft", "NOTE-0001");

    await expect(
      relocateArtifact(
        { type: "notebook", vaultRoot: vault, project: "p", id: "NOTE-0001", bucket: "nonexistent" },
        structure,
      ),
    ).rejects.toThrow(/unknown bucket/);
  });
});
