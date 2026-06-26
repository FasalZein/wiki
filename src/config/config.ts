import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

import type { WikiConfig } from "./types";
import { homeDir, isFileNotFound, isRecord } from "../util";

export async function getConfig(): Promise<WikiConfig> {
  const configPath = join(homeDir(), ".config", "wiki", "config.toml");
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return defaultConfig();
    }
    throw error;
  }

  const parsed = parse(contents);
  if (!isRecord(parsed.vault) || typeof parsed.vault.root !== "string") {
    throw new Error("Config is missing vault.root");
  }

  return {
    vault: { root: parsed.vault.root },
  };
}

function defaultConfig(): WikiConfig {
  return {
    vault: { root: process.env.KNOWLEDGE_VAULT_ROOT ?? `${homeDir()}/Knowledge` },
  };
}
