import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WikiVaultConfig = {
  default_project?: string;
  search: {
    auto_refresh: boolean;
  };
};

const DEFAULT_CONFIG: WikiVaultConfig = {
  search: {
    auto_refresh: true,
  },
};

const CONFIG_REL = join(".wiki", "config.json");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readWikiConfig(vaultPath: string): Promise<WikiVaultConfig> {
  const configPath = join(vaultPath, CONFIG_REL);
  if (!(await exists(configPath))) {
    return { ...DEFAULT_CONFIG, search: { ...DEFAULT_CONFIG.search } };
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<WikiVaultConfig>;

  return {
    ...(parsed.default_project !== undefined ? { default_project: parsed.default_project } : {}),
    search: {
      auto_refresh: parsed.search?.auto_refresh ?? DEFAULT_CONFIG.search.auto_refresh,
    },
  };
}

export async function writeWikiConfig(vaultPath: string, config: WikiVaultConfig): Promise<void> {
  const configPath = join(vaultPath, CONFIG_REL);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

export async function initWikiConfig(vaultPath: string, projectName?: string): Promise<boolean> {
  const configPath = join(vaultPath, CONFIG_REL);
  if (await exists(configPath)) {
    return false;
  }

  const config: WikiVaultConfig = {
    ...(projectName !== undefined ? { default_project: projectName } : {}),
    search: { ...DEFAULT_CONFIG.search },
  };
  await writeWikiConfig(vaultPath, config);
  return true;
}
