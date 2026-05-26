import { resolve } from "node:path";

import { initVault } from "../../bootstrap/init";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleVault(args: string[]): Promise<CliResult> {
  const [action, ...rest] = args;
  if (action === "init") {
    return vaultInit(rest);
  }
  console.error(`unknown vault action: ${action ?? ""}`.trim());
  return { code: 1 };
}

async function vaultInit(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["plugin-source"]);
  const rawPath = parsed.positionals[0];
  if (rawPath === undefined) {
    console.error("missing required argument: path");
    return { code: 1 };
  }

  const vaultPath = resolve(rawPath);
  const pluginSource = stringValue(parsed.values, "plugin-source");
  const result = await initVault(vaultPath, pluginSource !== undefined ? { pluginSource } : undefined);

  if (result.created.length > 0) {
    console.log("created:");
    for (const item of result.created) {
      console.log(`  ${item}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log("skipped (already existed):");
    for (const item of result.skipped) {
      console.log(`  ${item}`);
    }
  }

  return { code: 0 };
}
