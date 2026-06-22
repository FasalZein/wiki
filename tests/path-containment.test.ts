import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeSegment } from "../src/artifacts/paths";
import { createArtifact, readArtifact, relocateArtifact } from "../src/artifacts/store";

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
});

function decisionFields(title = "Use SQLite"): Record<string, string> {
  return {
    title,
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
