import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

import type { WikiConfig } from "./types";

export async function getConfig(): Promise<WikiConfig> {
  const configPath = join(homeDirectory(), ".config", "wiki", "config.toml");
  const parsed = parse(await readFile(configPath, "utf8"));
  if (!isRecord(parsed.vault) || typeof parsed.vault.root !== "string") {
    throw new Error("Config is missing vault.root");
  }

  return {
    vault: { root: parsed.vault.root },
    research: { sources: [] },
    harness: { detected: "none" },
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
