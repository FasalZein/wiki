import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextId } from "../src/artifacts/id";
import { buildIdIndex } from "../src/artifacts/id-index";
import { createArtifact } from "../src/artifacts/store";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-id-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  return vaultRoot;
}

describe("nextId", () => {
  test("empty directory starts at 0001", async () => {
    const vault = await createVault("test");
    expect(await nextId("prd", vault, "test")).toBe("PRD-0001");
    expect(await nextId("decision", vault, "test")).toBe("ADR-0001");
    expect(await nextId("slice", vault, "test")).toBe("SLICE-0001");
  });

  test("continues from existing 3-digit legacy IDs", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    await writeFile(join(prds, "PRD-001.md"), "existing");
    await writeFile(join(prds, "PRD-002.md"), "existing");

    expect(await nextId("prd", vault, "test")).toBe("PRD-0003");
  });

  test("continues from existing 4-digit IDs", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    await writeFile(join(prds, "PRD-0005.md"), "existing");

    expect(await nextId("prd", vault, "test")).toBe("PRD-0006");
  });

  test("continues from ADR-format IDs (NNNN-*.md) for decisions", async () => {
    const vault = await createVault("test");
    const adrs = join(vault, "projects", "test", "adrs");
    await writeFile(join(adrs, "0017-obsidian-cli-write-substrate.md"), "existing");

    expect(await nextId("decision", vault, "test")).toBe("ADR-0018");
  });

  test("handles mixed formats in the same directory", async () => {
    const vault = await createVault("test");
    const adrs = join(vault, "projects", "test", "adrs");
    await writeFile(join(adrs, "0005-old-decision.md"), "legacy");
    await writeFile(join(adrs, "ADR-0003.md"), "new format");

    // Highest is 5 (from 0005-old-decision.md), next is 6
    expect(await nextId("decision", vault, "test")).toBe("ADR-0006");
  });

  test("handles gaps by using highest + 1", async () => {
    const vault = await createVault("test");
    const slices = join(vault, "projects", "test", "slices");
    await writeFile(join(slices, "SLICE-0001.md"), "existing");
    await writeFile(join(slices, "SLICE-0003.md"), "existing");

    // Should be 4 (highest + 1), not 2 (gap fill)
    expect(await nextId("slice", vault, "test")).toBe("SLICE-0004");
  });

  test("ADR-format regex does not affect non-decision types", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    // A stray numbered file in prds should not be matched
    await writeFile(join(prds, "0099-random-notes.md"), "stray file");

    expect(await nextId("prd", vault, "test")).toBe("PRD-0001");
  });

  test("handles 3-digit and 4-digit IDs together", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    await writeFile(join(prds, "PRD-002.md"), "3-digit");
    await writeFile(join(prds, "PRD-0010.md"), "4-digit");

    expect(await nextId("prd", vault, "test")).toBe("PRD-0011");
  });

  test("doc ids are globally unique across category subfolders", async () => {
    const vault = await createVault("test");
    const docs = join(vault, "projects", "test", "docs");
    await mkdir(join(docs, "research"), { recursive: true });
    await mkdir(join(docs, "runbooks"), { recursive: true });
    await writeFile(join(docs, "research", "DOC-0004-a.md"), "existing");
    await writeFile(join(docs, "runbooks", "DOC-0009-b.md"), "existing");
    await writeFile(join(docs, "DOC-0002-flat.md"), "existing");

    expect(await nextId("doc", vault, "test")).toBe("DOC-0010");
  });

  test("counts a frontmatter id higher than any filename id", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    // A date-named file whose frontmatter id (PRD-0042) outranks every filename.
    await writeFile(join(prds, "2026-06-26-some-prd.md"), "---\nid: PRD-0042\n---\nbody\n");
    await writeFile(join(prds, "PRD-0007.md"), "---\nid: PRD-0007\n---\nbody\n");

    expect(await nextId("prd", vault, "test")).toBe("PRD-0043");
  });
});

describe("buildIdIndex", () => {
  test("maps frontmatter id -> path and ignores id-less files", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    await writeFile(join(prds, "2026-06-26-named.md"), "---\nid: PRD-0042\n---\nbody\n");
    await writeFile(join(prds, "no-id.md"), "---\ntitle: nope\n---\nbody\n");

    const index = await buildIdIndex(vault, "test");
    expect(index.get("PRD-0042")).toEqual([join(prds, "2026-06-26-named.md")]);
    expect([...index.keys()]).toEqual(["PRD-0042"]);
  });

  test("records a duplicate id as multiple paths", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    await writeFile(join(prds, "a.md"), "---\nid: PRD-0001\n---\nbody\n");
    await writeFile(join(prds, "b.md"), "---\nid: PRD-0001\n---\nbody\n");

    const index = await buildIdIndex(vault, "test");
    expect(index.get("PRD-0001")?.length).toBe(2);
  });
});

describe("createArtifact collision safety", () => {
  test("two concurrent creates of the same type get distinct ids", async () => {
    const vault = await createVault("test");
    const make = () =>
      createArtifact({
        type: "prd",
        vaultRoot: vault,
        project: "test",
        fields: { title: "Concurrent", summary: "A populated summary here." },
      });

    const [a, b] = await Promise.all([make(), make()]);

    expect(a.id).not.toBe(b.id);
    expect(await Bun.file(a.path).exists()).toBe(true);
    expect(await Bun.file(b.path).exists()).toBe(true);
  });

  test("throws after exhausting MAX_ATTEMPTS when every recomputed id keeps colliding", async () => {
    const vault = await createVault("test");
    const prds = join(vault, "projects", "test", "prds");
    // Pre-create a file at the target path that the filename scan and id index both
    // MISS (lowercase prefix, no frontmatter id), so nextId always returns PRD-0001.
    // On a case-insensitive filesystem the exclusive ('wx') write to PRD-0001-*.md
    // collides with this every attempt, so the bounded retry loop exhausts and throws.
    const probe = join(prds, "probe.md");
    await writeFile(probe, "x");
    const lower = join(prds, "probe-2.md");
    await writeFile(lower, "x");
    const caseInsensitive = await Bun.file(join(prds, "PROBE.md")).exists();
    await rm(probe);
    await rm(lower);
    if (!caseInsensitive) return; // can't force a deterministic collision on a case-sensitive FS

    // The allocator slugs "Collide" -> "collide"; pre-occupy the lowercased same path.
    await writeFile(join(prds, "prd-0001-collide.md"), "x");
    await expect(
      createArtifact({
        type: "prd",
        vaultRoot: vault,
        project: "test",
        fields: { title: "Collide", summary: "A populated summary here." },
      }),
    ).rejects.toThrow();
  });
});
