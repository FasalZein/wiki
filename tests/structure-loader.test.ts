import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadStructure, DEFAULT_STRUCTURE } from "../src/artifacts/registry";
import { nextId } from "../src/artifacts/id";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeVault(wikiJson?: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-struct-"));
  tempPaths.push(vaultRoot);
  if (wikiJson !== undefined) await writeFile(join(vaultRoot, "wiki.json"), wikiJson);
  return vaultRoot;
}

async function makeProject(vaultRoot: string, project: string, folders: string[]): Promise<void> {
  for (const folder of folders) {
    await mkdir(join(vaultRoot, "projects", project, folder), { recursive: true });
  }
}

describe("loadStructure (per-vault runtime config read)", () => {
  test("a vault with no wiki.json falls back to the bundled default kinds", async () => {
    const vault = await makeVault();
    const structure = await loadStructure(vault);
    expect(structure.specFor("prd").prefix).toBe("PRD");
    expect(structure.specFor("research").folder).toBe("research");
    expect(structure.specFor("handoff").dedup).toBe(false);
    // Same shape as the bundled default.
    expect(structure.specFor("slice")).toEqual(DEFAULT_STRUCTURE.specFor("slice"));
  });

  test("a custom wiki.json in the vault overrides the bundled default", async () => {
    const vault = await makeVault(JSON.stringify({
      kinds: { prd: { prefix: "REQ", folder: "requirements", dedup: true } },
    }));
    const structure = await loadStructure(vault);
    expect(structure.specFor("prd").prefix).toBe("REQ");
    expect(structure.specFor("prd").folder).toBe("requirements");
  });

  test("two vaults with different configs yield different structures in one run", async () => {
    const a = await makeVault(JSON.stringify({ kinds: { prd: { prefix: "AAA", folder: "prds", dedup: true } } }));
    const b = await makeVault(JSON.stringify({ kinds: { prd: { prefix: "BBB", folder: "prds", dedup: true } } }));
    expect((await loadStructure(a)).specFor("prd").prefix).toBe("AAA");
    expect((await loadStructure(b)).specFor("prd").prefix).toBe("BBB");
  });

  test("a malformed wiki.json fails loudly at load", async () => {
    const vault = await makeVault('{ "kinds": { "prd": { "prefix": 123 } } }');
    await expect(loadStructure(vault)).rejects.toThrow(/prd/);
  });

  test("invalid JSON fails loudly at load", async () => {
    const vault = await makeVault("{ not json");
    await expect(loadStructure(vault)).rejects.toThrow();
  });

  test("the returned Structure is a plain synchronous object (specFor is not a promise)", async () => {
    const structure = await loadStructure(await makeVault());
    const spec = structure.specFor("prd");
    expect(spec).not.toBeInstanceOf(Promise);
    expect(spec.prefix).toBe("PRD");
  });
});

describe("nextId honors the per-vault Structure (tracer through id-allocation path)", () => {
  test("a custom-prefix wiki.json allocates ids with that prefix", async () => {
    const vault = await makeVault(JSON.stringify({
      kinds: { prd: { prefix: "REQ", folder: "prds", dedup: true } },
    }));
    await makeProject(vault, "p", ["prds"]);
    const structure = await loadStructure(vault);
    expect(await nextId("prd", vault, "p", structure)).toBe("REQ-0001");
  });

  test("with no wiki.json, nextId uses today's default prefixes", async () => {
    const vault = await makeVault();
    await makeProject(vault, "p", ["prds", "adrs"]);
    const structure = await loadStructure(vault);
    expect(await nextId("prd", vault, "p", structure)).toBe("PRD-0001");
    expect(await nextId("decision", vault, "p", structure)).toBe("ADR-0001");
  });
});
