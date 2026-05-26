import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { initVault } from "../src/bootstrap/init";
import { syncVault } from "../src/bootstrap/sync";
import { loadPluginManifest, requiredPlugins } from "../src/bootstrap/manifest";
import { readLockfile } from "../src/bootstrap/plugins";
import type { PluginManifest } from "../src/bootstrap/manifest";

const FIXTURE_PLUGINS = resolve(import.meta.dir, "fixtures/plugins");
const REPO_TEMPLATES = resolve(import.meta.dir, "..", "templates");

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function makeTempVault(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "wiki-sync-"));
  tempPaths.push(base);
  const vault = join(base, "vault");
  await initVault(vault);
  return vault;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("syncVault", () => {
  let manifest: PluginManifest;

  test("sync installs missing plugins from lockfile", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const repoRoot = resolve(import.meta.dir, "..");

    const result = await syncVault(vault, repoRoot, {
      pluginSource: FIXTURE_PLUGINS,
    });

    const required = requiredPlugins(manifest);
    for (const p of required) {
      expect(
        await exists(join(vault, ".obsidian", "plugins", p.id, "manifest.json")),
      ).toBe(true);
    }
    expect(result.plugins.installed.sort()).toEqual(
      required.map((p) => p.id).sort(),
    );
    expect(result.plugins.skipped).toHaveLength(0);
  });

  test("sync skips already-installed plugins at correct version", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const repoRoot = resolve(import.meta.dir, "..");

    // First sync — installs everything
    await syncVault(vault, repoRoot, { pluginSource: FIXTURE_PLUGINS });

    // Second sync — everything should be skipped
    const result = await syncVault(vault, repoRoot, {
      pluginSource: FIXTURE_PLUGINS,
    });

    const required = requiredPlugins(manifest);
    expect(result.plugins.skipped.sort()).toEqual(
      required.map((p) => p.id).sort(),
    );
    expect(result.plugins.installed).toHaveLength(0);
  });

  test("sync writes default configs for plugins missing data.json", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const repoRoot = resolve(import.meta.dir, "..");

    const result = await syncVault(vault, repoRoot, {
      pluginSource: FIXTURE_PLUGINS,
    });

    const required = requiredPlugins(manifest);
    for (const p of required) {
      expect(
        await exists(join(vault, ".obsidian", "plugins", p.id, "data.json")),
      ).toBe(true);
    }
    expect(result.configs.written.sort()).toEqual(
      required.map((p) => p.id).sort(),
    );
  });

  test("sync deploys templates", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const repoRoot = resolve(import.meta.dir, "..");

    const result = await syncVault(vault, repoRoot, {
      pluginSource: FIXTURE_PLUGINS,
    });

    const templateFiles = await readdir(join(vault, "_templates"));
    expect(templateFiles.length).toBeGreaterThan(0);
    expect(result.templates.deployed.length).toBeGreaterThan(0);
    expect(result.templates.count).toBe(result.templates.deployed.length);
  });

  test("sync is idempotent — running twice produces same disk state", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const repoRoot = resolve(import.meta.dir, "..");

    // First sync
    await syncVault(vault, repoRoot, { pluginSource: FIXTURE_PLUGINS });

    // Snapshot disk state after first sync
    const required = requiredPlugins(manifest);
    const manifestContents: Record<string, string> = {};
    for (const p of required) {
      manifestContents[p.id] = await readFile(
        join(vault, ".obsidian", "plugins", p.id, "manifest.json"),
        "utf8",
      );
    }
    const lockAfterFirst = await readLockfile(vault);
    const templatesAfterFirst = (await readdir(join(vault, "_templates"))).sort();

    // Second sync
    await syncVault(vault, repoRoot, { pluginSource: FIXTURE_PLUGINS });

    // Verify same disk state
    for (const p of required) {
      const content = await readFile(
        join(vault, ".obsidian", "plugins", p.id, "manifest.json"),
        "utf8",
      );
      expect(content).toBe(manifestContents[p.id]);
    }
    const lockAfterSecond = await readLockfile(vault);
    expect(lockAfterSecond).toEqual(lockAfterFirst);
    const templatesAfterSecond = (await readdir(join(vault, "_templates"))).sort();
    expect(templatesAfterSecond).toEqual(templatesAfterFirst);
  });

  test("sync restores a removed plugin on second run", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const repoRoot = resolve(import.meta.dir, "..");

    // First sync
    await syncVault(vault, repoRoot, { pluginSource: FIXTURE_PLUGINS });

    // Remove one plugin from disk
    const required = requiredPlugins(manifest);
    const removedId = "dataview";
    await rm(join(vault, ".obsidian", "plugins", removedId), {
      recursive: true,
      force: true,
    });
    expect(
      await exists(join(vault, ".obsidian", "plugins", removedId)),
    ).toBe(false);

    // Second sync — should restore it
    const result = await syncVault(vault, repoRoot, {
      pluginSource: FIXTURE_PLUGINS,
    });

    expect(result.plugins.installed).toContain(removedId);
    expect(result.plugins.skipped).toHaveLength(required.length - 1);
    expect(
      await exists(join(vault, ".obsidian", "plugins", removedId, "manifest.json")),
    ).toBe(true);
  });
});
