import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getVaultRoot } from "../src/config/vault";

const originalEnv = { ...process.env };
const tempPaths: string[] = [];

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vault config", () => {
  test("getVaultRoot resolves the vault path from KNOWLEDGE_VAULT_ROOT first", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    expect(await getVaultRoot()).toBe(vaultRoot);
  });
});
