import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureArtifact } from "../src/artifacts/capture";
import { DEFAULT_STRUCTURE, loadStructure } from "../src/artifacts/registry";

// SLICE-0125: the wiki.json `skill` field resolves a skill to the kind it
// authors (kindForSkill), and a draft stamped per the authoring contract
// (`template: <kind>` + `project:`) is captured into the configured kind on a
// TEMP vault. The real $HOME/Knowledge vault is never touched.

const tempPaths: string[] = [];
const savedVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;

afterEach(async () => {
  if (savedVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = savedVaultRoot;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

describe("SLICE-0125: skill -> kind routing (wiki.json `skill` field)", () => {
  test("every default kind that declares a skill round-trips through kindForSkill", () => {
    expect(DEFAULT_STRUCTURE.kindForSkill("to-prd")).toBe("prd");
    expect(DEFAULT_STRUCTURE.kindForSkill("to-slices")).toBe("slice");
    expect(DEFAULT_STRUCTURE.kindForSkill("grill-with-docs")).toBe("decision");
    expect(DEFAULT_STRUCTURE.kindForSkill("handoff")).toBe("handoff");
    // `doc` declares no skill — an unmapped skill resolves to nothing, not a guess.
    expect(DEFAULT_STRUCTURE.kindForSkill("doc")).toBeUndefined();
    expect(DEFAULT_STRUCTURE.kindForSkill("no-such-skill")).toBeUndefined();
  });

  test("a custom wiki.json `skill` field maps that skill to its kind via loadStructure", async () => {
    const vaultRoot = await tmpDir("wiki-skill-kind-");
    await writeFile(
      join(vaultRoot, "wiki.json"),
      JSON.stringify({ kinds: { bug: { prefix: "BUG", folder: "bugs", dedup: false, skill: "file-a-bug" } } }),
    );
    const structure = await loadStructure(vaultRoot);
    expect(structure.kindForSkill("file-a-bug")).toBe("bug");
    expect(structure.kindForSkill("to-prd")).toBeUndefined(); // not in the custom tree
  });
});

describe("SLICE-0125: stamp-template authoring contract (end-to-end)", () => {
  test("a draft stamped `template:<kind>` + `project:` is captured into the configured kind", async () => {
    // A vault whose wiki.json registers a custom `bug` kind authored by a skill.
    const vaultRoot = await tmpDir("wiki-stamp-e2e-");
    await writeFile(
      join(vaultRoot, "wiki.json"),
      JSON.stringify({ kinds: { bug: { prefix: "BUG", folder: "bugs", dedup: false, skill: "file-a-bug" } } }),
    );
    await mkdir(join(vaultRoot, "projects", "proj", "bugs"), { recursive: true });
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    const src = await tmpDir("wiki-stamp-src-");
    const draft = join(src, "draft.md");
    // The authoring contract: stamp template:<kind> + project:<name>.
    await writeFile(draft, "---\ntemplate: bug\nproject: proj\ntitle: Crash On Save\n---\n# Crash On Save\n\nrepro\n");

    const outcome = await captureArtifact({ path: draft, cwd: src });

    expect(outcome?.outcome).toBe("captured");
    const filed = (await readdir(join(vaultRoot, "projects", "proj", "bugs"))).filter((f) => f.endsWith(".md"));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatch(/^BUG-\d{4}-crash-on-save\.md$/);
  });
});
