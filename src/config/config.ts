import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

import type { WikiConfig } from "./types";

export async function getConfig(): Promise<WikiConfig> {
  const configPath = join(homeDirectory(), ".config", "wiki", "config.toml");
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
    vault: { root: process.env.KNOWLEDGE_VAULT_ROOT ?? `${homeDirectory()}/Knowledge` },
  };
}

function homeDirectory(): string {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is not set");
  }
  return home;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
