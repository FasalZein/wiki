import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { getConfig } from "./config";

export async function getVaultRoot(): Promise<string> {
  const configuredRoot = await readConfiguredRoot();
  if (configuredRoot.length === 0) {
    throw unconfiguredError();
  }

  const root = resolve(expandHome(configuredRoot));
  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      throw new Error(`Vault root does not exist: ${root}`);
    }
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new Error(`Vault root does not exist: ${root}`);
    }
    throw error;
  }

  return root;
}

async function readConfiguredRoot(): Promise<string> {
  const envRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  if (envRoot !== undefined) {
    return envRoot;
  }

  try {
    return (await getConfig()).vault.root;
  } catch (error) {
    if (isFileNotFound(error) || isMissingVaultRoot(error)) {
      throw unconfiguredError();
    }
    throw error;
  }
}

function unconfiguredError(): Error {
  return new Error("Vault root not configured: set KNOWLEDGE_VAULT_ROOT or ~/.config/wiki/config.toml vault.root");
}

function expandHome(path: string): string {
  if (path === "~") {
    return homeDirectory();
  }
  if (path.startsWith("~/")) {
    return `${homeDirectory()}${path.slice(1)}`;
  }
  return path;
}

function homeDirectory(): string {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is not set");
  }
  return home;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isMissingVaultRoot(error: unknown): boolean {
  return error instanceof Error && error.message === "Config is missing vault.root";
}
