import { resolve } from "node:path";

import { runDoctor } from "../../bootstrap/doctor";
import { initVault } from "../../bootstrap/init";
import { parseCommand } from "../parse";
import { unknownMessage } from "../usage";
import type { CliResult } from "../dispatch";

export async function handleVault(args: string[]): Promise<CliResult> {
  const [action, ...rest] = args;
  if (action === "init") {
    return vaultInit(rest);
  }
  if (action === "doctor") {
    return vaultDoctor(rest);
  }
  console.error(unknownMessage("vault action", action ?? "", ["init", "doctor"]));
  return { code: 1 };
}

async function vaultInit(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const rawPath = parsed.positionals[0];
  if (rawPath === undefined) {
    console.error("missing required argument: path");
    return { code: 1 };
  }

  const vaultPath = resolve(rawPath);
  const result = await initVault(vaultPath);

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

async function vaultDoctor(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const rawPath = parsed.positionals[0] ?? ".";
  const vaultPath = resolve(rawPath);

  const result = await runDoctor(vaultPath);

  if (result.clean) {
    console.log("vault is clean — no drift detected");
    return { code: 0 };
  }

  console.log(`found ${result.issues.length} issue(s):\n`);
  for (const issue of result.issues) {
    console.log(`  [${issue.type}] ${issue.message}`);
  }

  return { code: 1 };
}
