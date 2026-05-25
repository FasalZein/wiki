import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { getConfig } from "./config";

export async function getVaultRoot(): Promise<string> {
  const configuredRoot = await readConfiguredRoot();
  if (configuredRoot.length === 0) {
    throw unconfiguredError();
  }

  const root = resolve(configuredRoot);
  const stats = await stat(root);
  if (!stats.isDirectory()) {
    throw new Error(`Vault root does not exist: ${root}`);
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
    if (isFileNotFound(error)) {
      throw unconfiguredError();
    }
    throw error;
  }
}

function unconfiguredError(): Error {
  return new Error("Vault root not configured: set KNOWLEDGE_VAULT_ROOT or ~/.config/wiki/config.toml vault.root");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
