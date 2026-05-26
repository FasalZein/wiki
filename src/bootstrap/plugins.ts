import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PluginManifest } from "./manifest";
import { requiredPlugins } from "./manifest";
import { ensureObsidian, obsidianPluginInstall, obsidianPluginEnable } from "../integrations/obsidian";

export type PluginInstallResult = {
  installed: string[];
  skipped: string[];
};

export type PluginLockfile = {
  version: number;
  plugins: Record<string, { version: string; repo: string }>;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"] as const;

async function copyFromLocal(
  sourceDir: string,
  pluginId: string,
  destDir: string
): Promise<void> {
  const srcBase = join(sourceDir, pluginId);
  for (const file of PLUGIN_FILES) {
    const src = join(srcBase, file);
    if (await exists(src)) {
      await copyFile(src, join(destDir, file));
    }
  }
}

export async function installPlugins(
  vaultPath: string,
  manifest: PluginManifest,
  options?: { pluginSource?: string }
): Promise<PluginInstallResult> {
  const installed: string[] = [];
  const skipped: string[] = [];

  const lockfile = await readLockfile(vaultPath);
  const required = requiredPlugins(manifest);

  // Ensure Obsidian is reachable when using the CLI path
  if (!options?.pluginSource) {
    await ensureObsidian();
  }

  for (const entry of required) {
    const pluginDir = join(vaultPath, ".obsidian", "plugins", entry.id);
    const manifestPath = join(pluginDir, "manifest.json");

    // Check if already installed at correct version
    if (await exists(manifestPath)) {
      const lockEntry = lockfile.plugins[entry.id];
      if (lockEntry) {
        const raw = await readFile(manifestPath, "utf8");
        const diskManifest = JSON.parse(raw) as { version: string };
        if (diskManifest.version === lockEntry.version) {
          skipped.push(entry.id);
          continue;
        }
      }
    }

    if (options?.pluginSource) {
      // Air-gapped: copy from local directory
      await mkdir(pluginDir, { recursive: true });
      await copyFromLocal(options.pluginSource, entry.id, pluginDir);
    } else {
      // Normal: install via Obsidian CLI
      await obsidianPluginInstall(entry.id);
      await obsidianPluginEnable(entry.id);
    }

    installed.push(entry.id);
  }

  return { installed, skipped };
}

export async function writeCommunityPlugins(
  vaultPath: string,
  pluginIds: string[]
): Promise<void> {
  const filePath = join(vaultPath, ".obsidian", "community-plugins.json");
  await writeFile(filePath, JSON.stringify(pluginIds, null, 2) + "\n");
}

export async function updateLockfile(
  vaultPath: string,
  installedPlugins: Record<string, { version: string; repo: string }>
): Promise<void> {
  const lockfile = await readLockfile(vaultPath);
  for (const [id, info] of Object.entries(installedPlugins)) {
    lockfile.plugins[id] = info;
  }
  const filePath = join(vaultPath, ".wiki", "plugin-lock.json");
  await writeFile(filePath, JSON.stringify(lockfile, null, 2) + "\n");
}

export async function readLockfile(
  vaultPath: string
): Promise<PluginLockfile> {
  const filePath = join(vaultPath, ".wiki", "plugin-lock.json");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as PluginLockfile;
}
