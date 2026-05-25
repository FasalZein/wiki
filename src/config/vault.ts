import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function getVaultRoot(): Promise<string> {
  const envRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  if (envRoot === undefined || envRoot.length === 0) {
    throw new Error("Vault root not configured: set KNOWLEDGE_VAULT_ROOT or ~/.config/wiki/config.toml vault.root");
  }

  const root = resolve(envRoot);
  const stats = await stat(root);
  if (!stats.isDirectory()) {
    throw new Error(`Vault root does not exist: ${root}`);
  }

  return root;
}
