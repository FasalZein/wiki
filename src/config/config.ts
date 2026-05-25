import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

import type { WikiConfig } from "./types";

const defaultResearchSources = [
  "~/.pi/artifacts/research",
  "~/.codex/artifacts/research",
  "~/.claude/artifacts/research",
  "~/Research",
];

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

  const sources = isRecord(parsed.research) && isStringArray(parsed.research.sources) ? parsed.research.sources : [];

  return {
    vault: { root: parsed.vault.root },
    research: { sources },
    harness: { detected: "none" },
  };
}

function defaultConfig(): WikiConfig {
  return {
    vault: { root: process.env.KNOWLEDGE_VAULT_ROOT ?? `${homeDirectory()}/Knowledge` },
    research: { sources: defaultResearchSources },
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
