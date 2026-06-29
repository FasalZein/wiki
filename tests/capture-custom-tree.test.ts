import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { captureArtifact } from "../src/artifacts/capture";

// SLICE-0116: capture's kind resolution must ride the SAME per-vault structure
// the write step uses (loadStructure(vaultRoot)), not the bundled DEFAULT_STRUCTURE.
// Proven on a TEMP vault whose wiki.json declares a `bug` kind the default tree
// has never seen: capture recognizes it, files it into bugs/ with a BUG-prefixed
// id, and a re-fire is idempotent. The real $HOME/Knowledge vault is never touched.

const tempPaths: string[] = [];
const savedVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;

afterEach(async () => {
  if (savedVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = savedVaultRoot;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// A custom tree the default structure does not contain: a `bug` leaf section
// (prefix BUG, folder bugs).
const customConfig = JSON.stringify({
  kinds: {
    bug: { prefix: "BUG", folder: "bugs", dedup: false },
  },
});

async function makeVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-capture-"));
  tempPaths.push(vaultRoot);
  await writeFile(join(vaultRoot, "wiki.json"), customConfig);
  await mkdir(join(vaultRoot, "projects", project, "bugs"), { recursive: true });
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  return vaultRoot;
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-capture-src-"));
  tempPaths.push(dir);
  return dir;
}

async function lsBugs(vaultRoot: string, project: string): Promise<string[]> {
  return (await readdir(join(vaultRoot, "projects", project, "bugs")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".md"),
  );
}

describe("SLICE-0116: capture rides the per-vault tree", () => {
  test("a custom-tree bucket is recognized and filed with a section-prefixed id", async () => {
    const vaultRoot = await makeVault("proj");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: A Custom Bug\n---\n# A Custom Bug\n\nbody\n");

    const outcome = await captureArtifact({ path: file, cwd: dir });

    expect(outcome?.outcome).toBe("captured");
    const filed = await lsBugs(vaultRoot, "proj");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatch(/^BUG-\d{4}-a-custom-bug\.md$/);
    // the filed artifact carries the section prefix and resolved project
    const captured = matter(await readFile(join(vaultRoot, "projects", "proj", "bugs", filed[0]!), "utf8"));
    expect(captured.data.id).toMatch(/^BUG-\d{4}$/);
    expect(captured.data.project).toBe("proj");
  });

  test("re-firing on the same draft is idempotent (no double-create)", async () => {
    const vaultRoot = await makeVault("proj");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: Idempotent Bug\n---\n# Idempotent Bug\n");

    const first = await captureArtifact({ path: file, cwd: dir });
    expect(first?.outcome).toBe("captured");
    // the source draft is stamped with the minted id, so a re-fire sees it already indexed
    const second = await captureArtifact({ path: file, cwd: dir });
    expect(second?.outcome).toBe("captured");

    expect(await lsBugs(vaultRoot, "proj")).toHaveLength(1);
  });
});
