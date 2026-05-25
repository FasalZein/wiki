import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { getConfig } from "./config";

export async function getVaultRoot(): Promise<string> {
  const configuredRoot = process.env.KNOWLEDGE_VAULT_ROOT ?? (await getConfig()).vault.root;
  if (configuredRoot.length === 0) {
    throw new Error("Vault root not configured: set KNOWLEDGE_VAULT_ROOT or ~/.config/wiki/config.toml vault.root");
  }

  const root = resolve(configuredRoot);
  const stats = await stat(root);
  if (!stats.isDirectory()) {
    throw new Error(`Vault root does not exist: ${root}`);
  }

  return root;
}
