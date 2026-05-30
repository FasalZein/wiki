import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextId } from "../src/artifacts/id";

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
  await mkdir(join(projectPath, "handovers"));
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
});
