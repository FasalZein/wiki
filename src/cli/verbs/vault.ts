import { dirname, join, resolve } from "node:path";

import { runDoctor } from "../../bootstrap/doctor";
import { evaluateSetup } from "../../bootstrap/setup-doctor";
import { anyHookWired, unreachableSubagents } from "./hooks";
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
  const parsed = parseCommand(args, [], [], ["setup"]);
  if (parsed.values.setup === true) return setupDoctor();
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

/**
 * `wiki doctor --setup` — distribution health (binary freshness, skill-bundle
 * presence, hook install state), distinct from vault-content drift. Resolves the
 * facts from the running bundle: the repo root is two dirs above the entry
 * (dist/cli.js or src/cli.ts), so the same wiring serves dev and a built binary.
 */
async function setupDoctor(): Promise<CliResult> {
  const binaryPath = Bun.main;
  const repoRoot = dirname(dirname(binaryPath));
  const result = await evaluateSetup({
    binaryPath,
    srcDir: join(repoRoot, "src"),
    skillBundlePath: join(repoRoot, "skills", "wiki", "SKILL.md"),
    hookWired: await anyHookWired(),
    unreachableSubagents: await unreachableSubagents(),
  });

  if (result.clean) {
    console.log("setup is healthy — binary fresh, skill bundle present, hook wired");
    return { code: 0 };
  }

  console.log(`found ${result.issues.length} setup issue(s):\n`);
  for (const issue of result.issues) {
    console.log(`  [${issue.type}] ${issue.message}`);
  }
  return { code: 1 };
}
