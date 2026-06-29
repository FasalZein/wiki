import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureArtifact } from "../src/artifacts/capture";

// SLICE-0120: capture decides on FRONTMATTER only (the hook passes every write,
// no area filter), so the contract is pinned per branch on a TEMP vault:
//   - template:<kind> resolvable -> captured (filed via mintAndWrite)
//   - id:/template: that resolves to NO registered kind -> WARN (never null,
//     never a wrong-kind write) — this is the regression guard
//   - no id and no template -> null (silent): capture sees ordinary code edits
//     too, so a bare draft cannot warn without spamming every write
// The real $HOME/Knowledge vault is never touched.

const tempPaths: string[] = [];
const savedVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;

afterEach(async () => {
  if (savedVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = savedVaultRoot;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// A minimal custom tree with a single `bug` kind (prefix BUG, folder bugs).
const customConfig = JSON.stringify({
  kinds: { bug: { prefix: "BUG", folder: "bugs", dedup: false } },
});

async function makeVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-capture-fm-"));
  tempPaths.push(vaultRoot);
  await writeFile(join(vaultRoot, "wiki.json"), customConfig);
  await mkdir(join(vaultRoot, "projects", project, "bugs"), { recursive: true });
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  return vaultRoot;
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-capture-fm-src-"));
  tempPaths.push(dir);
  return dir;
}

async function lsBugs(vaultRoot: string, project: string): Promise<string[]> {
  return (await readdir(join(vaultRoot, "projects", project, "bugs")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".md"),
  );
}

describe("SLICE-0120: capture is honest on frontmatter", () => {
  test("a template:<kind> draft resolvable against the vault tree is captured", async () => {
    const vaultRoot = await makeVault("proj");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: Filed Bug\n---\n# Filed Bug\n\nbody\n");

    const outcome = await captureArtifact({ path: file, cwd: dir });

    expect(outcome?.outcome).toBe("captured");
    expect(await lsBugs(vaultRoot, "proj")).toHaveLength(1);
  });

  test("an id/template-bearing draft that resolves to NO registered kind WARNS, not null", async () => {
    // Regression guard: capture must NOT return null on an artifact-shaped draft
    // whose declared kind the vault does not register. A null here would silently
    // drop an authored artifact.
    await makeVault("proj");
    const dir = await tmpDir();

    // template names a kind the custom vault does not register
    const byTemplate = join(dir, "unknown-template.md");
    await writeFile(byTemplate, "---\ntemplate: epic\nproject: proj\ntitle: Unknown Template\n---\n# Unknown Template\n");
    const t = await captureArtifact({ path: byTemplate, cwd: dir });
    expect(t).not.toBeNull();
    expect(t?.outcome).toBe("warn");
    expect(t && t.outcome === "warn" ? t.warning : "").toContain("no registered wiki kind");

    // id whose prefix maps to no registered kind
    const byId = join(dir, "unknown-id.md");
    await writeFile(byId, "---\nid: EPIC-0001\nproject: proj\ntitle: Unknown Id\n---\n# Unknown Id\n");
    const i = await captureArtifact({ path: byId, cwd: dir });
    expect(i).not.toBeNull();
    expect(i?.outcome).toBe("warn");
  });

  test("a draft with no id and no template returns null (silent) — capture sees every write", async () => {
    // The hook passes the raw tool path with no area filter, so capture fires on
    // ordinary code edits too. A bare draft therefore CANNOT warn without spamming
    // every non-artifact write; it must stay silent (null). The forgot-to-stamp
    // safety net is the session-end reminder (SLICE-0125), not a capture warning.
    await makeVault("proj");
    const dir = await tmpDir();
    const file = join(dir, "ordinary.md");
    await writeFile(file, "---\ntitle: Just A Note\n---\n# Just A Note\n\nnot an artifact\n");

    const outcome = await captureArtifact({ path: file, cwd: dir });

    expect(outcome).toBeNull();
  });

  test("re-firing capture on an already-filed (id-stamped) draft is idempotent", async () => {
    const vaultRoot = await makeVault("proj");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: Once Only\n---\n# Once Only\n");

    const first = await captureArtifact({ path: file, cwd: dir });
    expect(first?.outcome).toBe("captured");
    const second = await captureArtifact({ path: file, cwd: dir });
    expect(second?.outcome).toBe("captured");

    expect(await lsBugs(vaultRoot, "proj")).toHaveLength(1);
  });
});
