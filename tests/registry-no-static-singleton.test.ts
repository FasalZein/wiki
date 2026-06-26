import { describe, expect, test, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStructure } from "../src/artifacts/registry";
import { nextId } from "../src/artifacts/id";

const repoRoot = import.meta.dir.replace(/\/tests$/, "");
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeVault(wikiJson?: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-singleton-"));
  tempPaths.push(vaultRoot);
  await mkdir(join(vaultRoot, "projects", "p", "prds"), { recursive: true });
  if (wikiJson !== undefined) await writeFile(join(vaultRoot, "wiki.json"), wikiJson);
  return vaultRoot;
}

/** Walk src/ collecting every .ts file. */
async function srcFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await srcFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("SLICE-0104: no residual static singleton", () => {
  test("no module in src reads wiki.json at import time", async () => {
    const files = await srcFiles(join(repoRoot, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      // A module-scope `import ... from ".../wiki.json"` is the static read this slice removes.
      if (/^\s*import\s+.*from\s+["'][^"']*wiki\.json["']/m.test(content)) {
        offenders.push(file.replace(repoRoot + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("two vaults with different configs yield different ids in one run (per-vault, not bundled)", async () => {
    const a = await makeVault(JSON.stringify({ kinds: { prd: { prefix: "AAA", folder: "prds", dedup: true } } }));
    const b = await makeVault(JSON.stringify({ kinds: { prd: { prefix: "BBB", folder: "prds", dedup: true } } }));
    const structA = await loadStructure(a);
    const structB = await loadStructure(b);
    // Same process, same call — only the per-vault structure differs.
    expect(await nextId("prd", a, "p", structA)).toBe("AAA-0001");
    expect(await nextId("prd", b, "p", structB)).toBe("BBB-0001");
  });

  test("a no-config vault falls back to the bundled default prefix", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    expect(await nextId("prd", vault, "p", structure)).toBe("PRD-0001");
  });

  test("a malformed config fails at load with a clear message", async () => {
    const vault = await makeVault('{ "kinds": { "prd": { "prefix": 123 } } }');
    await expect(loadStructure(vault)).rejects.toThrow(/prd/);
  });
});
