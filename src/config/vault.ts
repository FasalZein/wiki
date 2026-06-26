import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { getConfig } from "./config";
import { expandHome, isFileNotFound } from "../util";

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

/**
 * Resolve the configured vault path for DISPLAY only — never throws and does not
 * require the directory to exist (so it works before `vault init`). Returns null
 * when nothing is configured. Used by the dispatch banner so every command can
 * state where artifacts go, deterministically, without failing the command.
 */
export async function resolveVaultRootForDisplay(): Promise<string | null> {
  try {
    const configuredRoot = await readConfiguredRoot();
    if (configuredRoot.length === 0) return null;
    return resolve(expandHome(configuredRoot));
  } catch {
    return null;
  }
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

function isMissingVaultRoot(error: unknown): boolean {
  return error instanceof Error && error.message === "Config is missing vault.root";
}
