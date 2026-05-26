import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  installPlugins,
  writeCommunityPlugins,
  updateLockfile,
  readLockfile,
} from "../src/bootstrap/plugins";
import { loadPluginManifest, requiredPlugins } from "../src/bootstrap/manifest";
import type { PluginManifest } from "../src/bootstrap/manifest";

const FIXTURE_PLUGINS = resolve(import.meta.dir, "fixtures/plugins");

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

async function makeTempVault(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "wiki-plugins-"));
  tempPaths.push(base);
  const vault = join(base, "vault");
  await mkdir(join(vault, ".obsidian", "plugins"), { recursive: true });
  await mkdir(join(vault, ".wiki"), { recursive: true });
  await writeFile(
    join(vault, ".wiki", "plugin-lock.json"),
    JSON.stringify({ version: 1, plugins: {} }, null, 2) + "\n"
  );
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

describe("plugin install", () => {
  let manifest: PluginManifest;

  test("installs all 5 required plugin dirs under .obsidian/plugins/", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    const result = await installPlugins(vault, manifest, {
      pluginSource: FIXTURE_PLUGINS,
    });

    const required = requiredPlugins(manifest);
    for (const p of required) {
      expect(await exists(join(vault, ".obsidian", "plugins", p.id))).toBe(
        true
      );
    }
    expect(result.installed.sort()).toEqual(
      required.map((p) => p.id).sort()
    );
    expect(result.skipped).toHaveLength(0);
  });

  test("each plugin dir contains main.js and manifest.json", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });

    const required = requiredPlugins(manifest);
    for (const p of required) {
      const pluginDir = join(vault, ".obsidian", "plugins", p.id);
      expect(await exists(join(pluginDir, "main.js"))).toBe(true);
      expect(await exists(join(pluginDir, "manifest.json"))).toBe(true);
    }
  });

  test("styles.css is copied when present in source", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });

    // All fixtures have styles.css
    const required = requiredPlugins(manifest);
    for (const p of required) {
      expect(
        await exists(join(vault, ".obsidian", "plugins", p.id, "styles.css"))
      ).toBe(true);
    }
  });

  test("community-plugins.json lists all installed plugin ids", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });

    const required = requiredPlugins(manifest);
    const ids = required.map((p) => p.id);
    await writeCommunityPlugins(vault, ids);

    const raw = await readFile(
      join(vault, ".obsidian", "community-plugins.json"),
      "utf8"
    );
    const list: string[] = JSON.parse(raw);
    expect(list.sort()).toEqual(ids.sort());
  });

  test("lockfile is updated with version and repo for each plugin", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();
    await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });

    const required = requiredPlugins(manifest);
    const pluginsRecord: Record<string, { version: string; repo: string }> = {};
    for (const p of required) {
      const mRaw = await readFile(
        join(vault, ".obsidian", "plugins", p.id, "manifest.json"),
        "utf8"
      );
      const mJson = JSON.parse(mRaw);
      pluginsRecord[p.id] = { version: mJson.version, repo: p.repo };
    }
    await updateLockfile(vault, pluginsRecord);

    const lock = await readLockfile(vault);
    expect(lock.version).toBe(1);
    for (const p of required) {
      expect(lock.plugins[p.id]).toBeDefined();
      expect(lock.plugins[p.id]!.repo).toBe(p.repo);
      expect(typeof lock.plugins[p.id]!.version).toBe("string");
    }
  });

  test("re-running install with matching lockfile skips already-installed plugins", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();

    // First install
    await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });

    // Build and write lockfile so versions match
    const required = requiredPlugins(manifest);
    const pluginsRecord: Record<string, { version: string; repo: string }> = {};
    for (const p of required) {
      const mRaw = await readFile(
        join(vault, ".obsidian", "plugins", p.id, "manifest.json"),
        "utf8"
      );
      const mJson = JSON.parse(mRaw);
      pluginsRecord[p.id] = { version: mJson.version, repo: p.repo };
    }
    await updateLockfile(vault, pluginsRecord);

    // Second install — everything should be skipped
    const result = await installPlugins(vault, manifest, {
      pluginSource: FIXTURE_PLUGINS,
    });
    expect(result.skipped.sort()).toEqual(required.map((p) => p.id).sort());
    expect(result.installed).toHaveLength(0);
  });

  test("missing plugin (removed from disk) gets re-installed on next run", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault();

    // First install + lockfile
    await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });
    const required = requiredPlugins(manifest);
    const pluginsRecord: Record<string, { version: string; repo: string }> = {};
    for (const p of required) {
      const mRaw = await readFile(
        join(vault, ".obsidian", "plugins", p.id, "manifest.json"),
        "utf8"
      );
      const mJson = JSON.parse(mRaw);
      pluginsRecord[p.id] = { version: mJson.version, repo: p.repo };
    }
    await updateLockfile(vault, pluginsRecord);

    // Remove one plugin from disk
    await rm(join(vault, ".obsidian", "plugins", "dataview"), {
      recursive: true,
      force: true,
    });

    // Re-install — dataview should be installed, rest skipped
    const result = await installPlugins(vault, manifest, {
      pluginSource: FIXTURE_PLUGINS,
    });
    expect(result.installed).toEqual(["dataview"]);
    expect(result.skipped).toHaveLength(required.length - 1);
  });

  test("readLockfile returns the correct structure", async () => {
    const vault = await makeTempVault();
    const lock = await readLockfile(vault);
    expect(lock.version).toBe(1);
    expect(lock.plugins).toEqual({});
  });
});
