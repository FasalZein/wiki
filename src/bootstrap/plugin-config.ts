import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PluginManifest } from "./manifest";
import { requiredPlugins, loadDefaultConfig } from "./manifest";

export type PluginConfigResult = {
  written: string[];
  skipped: string[];
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
 * Write default data.json for each required plugin that lacks one.
 * Blessed configs (at .wiki/blessed-config/<plugin-id>.json) take precedence
 * over CLI defaults.
 */
export async function writePluginConfigs(
  vaultPath: string,
  manifest: PluginManifest,
): Promise<PluginConfigResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  const required = requiredPlugins(manifest);

  for (const entry of required) {
    const dataPath = join(vaultPath, ".obsidian", "plugins", entry.id, "data.json");

    if (await exists(dataPath)) {
      skipped.push(entry.id);
      continue;
    }

    const blessedPath = join(vaultPath, ".wiki", "blessed-config", `${entry.id}.json`);

    if (await exists(blessedPath)) {
      await copyFile(blessedPath, dataPath);
    } else {
      const config = await loadDefaultConfig(entry);
      await writeFile(dataPath, JSON.stringify(config, null, 2) + "\n");
    }

    written.push(entry.id);
  }

  return { written, skipped };
}
