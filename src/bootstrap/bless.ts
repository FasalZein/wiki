import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadPluginManifest, loadDefaultConfig } from "./manifest";

export type BlessResult = {
  status: "blessed" | "not-found" | "no-config";
  plugin: string;
  message?: string;
};

export type ResetResult = {
  status: "reset" | "not-found" | "no-blessed-or-default";
  plugin: string;
  source?: "blessed" | "default";
  message?: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy current plugin data.json to blessed-config as the team default.
 */
export async function blessPlugin(
  vaultPath: string,
  pluginId: string,
): Promise<BlessResult> {
  const pluginDir = join(vaultPath, ".obsidian", "plugins", pluginId);

  if (!(await exists(pluginDir))) {
    return {
      status: "not-found",
      plugin: pluginId,
      message: `plugin directory not found: ${pluginId}`,
    };
  }

  const dataPath = join(pluginDir, "data.json");

  if (!(await exists(dataPath))) {
    return {
      status: "no-config",
      plugin: pluginId,
      message: `no data.json for plugin: ${pluginId}`,
    };
  }

  const blessedPath = join(
    vaultPath,
    ".wiki",
    "blessed-config",
    `${pluginId}.json`,
  );
  await copyFile(dataPath, blessedPath);

  return { status: "blessed", plugin: pluginId };
}

/**
 * Revert plugin data.json to blessed config, or CLI default if no blessed.
 */
export async function resetPlugin(
  vaultPath: string,
  pluginId: string,
): Promise<ResetResult> {
  const pluginDir = join(vaultPath, ".obsidian", "plugins", pluginId);
  const dataPath = join(pluginDir, "data.json");
  const blessedPath = join(
    vaultPath,
    ".wiki",
    "blessed-config",
    `${pluginId}.json`,
  );

  // Try blessed config first
  if (await exists(blessedPath)) {
    await copyFile(blessedPath, dataPath);
    return { status: "reset", plugin: pluginId, source: "blessed" };
  }

  // Try CLI default from manifest
  const manifest = await loadPluginManifest();
  const entry = manifest.plugins.find((p) => p.id === pluginId);

  if (entry && entry.defaultConfigPath) {
    try {
      const config = await loadDefaultConfig(entry);
      await writeFile(dataPath, JSON.stringify(config, null, 2) + "\n");
      return { status: "reset", plugin: pluginId, source: "default" };
    } catch {
      // default config file doesn't exist or is invalid
    }
  }

  return {
    status: "no-blessed-or-default",
    plugin: pluginId,
    message: `no blessed config or CLI default for plugin: ${pluginId}`,
  };
}
