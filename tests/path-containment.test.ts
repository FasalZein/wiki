import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeSegment } from "../src/artifacts/paths";
import { createArtifact as _createArtifact, readArtifact as _readArtifact, relocateArtifact as _relocateArtifact } from "../src/artifacts/store";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// SLICE-0104: thread DEFAULT_STRUCTURE (the default kinds these tests use).
const createArtifact = (input: Omit<Parameters<typeof _createArtifact>[0], "structure">) =>
  _createArtifact({ ...input, structure: DEFAULT_STRUCTURE });
const readArtifact = (input: Parameters<typeof _readArtifact>[0]) => _readArtifact(input, DEFAULT_STRUCTURE);
const relocateArtifact = (input: Parameters<typeof _relocateArtifact>[0]) => _relocateArtifact(input, DEFAULT_STRUCTURE);

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("path containment", () => {
  test("assertSafeSegment rejects traversal/separators/empties, accepts ids", () => {
    expect(() => assertSafeSegment("../x", "x")).toThrow();
    expect(() => assertSafeSegment("a/b", "x")).toThrow();
    expect(() => assertSafeSegment("a\\b", "x")).toThrow();
    expect(() => assertSafeSegment("..", "x")).toThrow();
    expect(() => assertSafeSegment(".", "x")).toThrow();
    expect(() => assertSafeSegment("", "x")).toThrow();
    expect(() => assertSafeSegment("a\0b", "x")).toThrow();
    expect(() => assertSafeSegment("wiki-v2", "x")).not.toThrow();
    expect(() => assertSafeSegment("PRD-0009", "x")).not.toThrow();
    expect(() => assertSafeSegment("SLICE-0054-foo", "x")).not.toThrow();
  });

  test("createArtifact with an escaping project writes nothing outside the vault", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await expect(
      createArtifact({ type: "decision", vaultRoot, project: "../escape", fields: decisionFields() }),
    ).rejects.toThrow();
    await expect(stat(join(vaultRoot, "..", "escape"))).rejects.toThrow();
  });

  test("readArtifact with a traversal id throws", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await expect(
      readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "../../etc/passwd" }),
    ).rejects.toThrow();
  });

  test("relocateArtifact validates its id (rejects traversal)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await expect(
      relocateArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "../../x", title: "X" }),
    ).rejects.toThrow();
  });

  test("create + read + retitle still works", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const a = await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });
    const read = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: a.id });
    expect(read.id).toBe(a.id);
    const moved = await relocateArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: a.id, title: "Renamed" });
    expect(moved.id).toBe(a.id);
  });

  test("resolves a date-named file by its frontmatter id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const datePath = join(vaultRoot, "projects", "wiki-v2", "slices", "2026-06-26-legacy-name.md");
    await writeFile(datePath, "---\nid: SLICE-9001\ntitle: Legacy\n---\nBody here.\n");
    const read = await readArtifact({ type: "slice", vaultRoot, project: "wiki-v2", id: "SLICE-9001" });
    expect(read.id).toBe("SLICE-9001");
    expect(read.path).toBe(datePath);
  });

  test("well-named file still resolves by filename glob (no regression)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const named = join(vaultRoot, "projects", "wiki-v2", "slices", "SLICE-9002-good-name.md");
    await writeFile(named, "---\nid: SLICE-9002\ntitle: Good\n---\nBody.\n");
    const read = await readArtifact({ type: "slice", vaultRoot, project: "wiki-v2", id: "SLICE-9002" });
    expect(read.path).toBe(named);
  });
});

function decisionFields(title = "Use SQLite"): Record<string, string> {
  return {
    title,
    summary: "A populated summary here.",
    project: "wiki-v2",
    status: "accepted",
    body: "Use SQLite for local persistence.",
  };
}

async function createFixtureVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}
