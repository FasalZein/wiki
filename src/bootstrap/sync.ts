import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadPluginManifest, requiredPlugins } from "./manifest";
import {
  installPlugins,
  updateLockfile,
  writeCommunityPlugins,
} from "./plugins";
import { writePluginConfigs } from "./plugin-config";
import { deployTemplates } from "./templates";
import type { PluginInstallResult } from "./plugins";
import type { PluginConfigResult } from "./plugin-config";
import type { TemplateDeployResult } from "./templates";

export type VaultSyncResult = {
  plugins: { installed: string[]; skipped: string[] };
  configs: { written: string[]; skipped: string[] };
  templates: { deployed: string[]; count: number };
};

export async function syncVault(
  vaultPath: string,
  repoRoot: string,
  options?: { pluginSource?: string },
): Promise<VaultSyncResult> {
  const manifest = await loadPluginManifest();
  const required = requiredPlugins(manifest);

  // Install plugins
  const pluginResult: PluginInstallResult = await installPlugins(
    vaultPath,
    manifest,
    options?.pluginSource ? { pluginSource: options.pluginSource } : undefined,
  );

  // Read installed manifest.json for each plugin and update lockfile
  const pluginsRecord: Record<string, { version: string; repo: string }> = {};
  for (const entry of required) {
    const manifestPath = join(
      vaultPath,
      ".obsidian",
      "plugins",
      entry.id,
      "manifest.json",
    );
    const raw = await readFile(manifestPath, "utf8");
    const diskManifest = JSON.parse(raw) as { version: string };
    pluginsRecord[entry.id] = { version: diskManifest.version, repo: entry.repo };
  }
  await updateLockfile(vaultPath, pluginsRecord);

  // Write community-plugins.json
  const pluginIds = required.map((p) => p.id);
  await writeCommunityPlugins(vaultPath, pluginIds);

  // Write plugin configs
  const configResult: PluginConfigResult = await writePluginConfigs(
    vaultPath,
    manifest,
  );

  // Deploy templates
  const templateResult: TemplateDeployResult = await deployTemplates(
    join(repoRoot, "templates"),
    join(vaultPath, "_templates"),
  );

  return {
    plugins: { installed: pluginResult.installed, skipped: pluginResult.skipped },
    configs: { written: configResult.written, skipped: configResult.skipped },
    templates: { deployed: templateResult.deployed, count: templateResult.count },
  };
}
