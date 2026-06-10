import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { runDoctor } from "../../bootstrap/doctor";
import { initVault } from "../../bootstrap/init";
import { syncVault } from "../../bootstrap/sync";
import { blessPlugin, resetPlugin } from "../../bootstrap/bless";
import { parseCommand, stringValue } from "../parse";
import { unknownMessage } from "../usage";
import type { CliResult } from "../dispatch";

function resolveRepoRoot(): string {
  const bundledRoot = resolve(import.meta.dir, "..");
  if (existsSync(resolve(bundledRoot, "templates"))) {
    return bundledRoot;
  }
  return resolve(import.meta.dir, "../../..");
}

export async function handleVault(args: string[]): Promise<CliResult> {
  const [action, ...rest] = args;
  if (action === "init") {
    return vaultInit(rest);
  }
  if (action === "sync") {
    return vaultSync(rest);
  }
  if (action === "config") {
    return vaultConfig(rest);
  }
  if (action === "doctor") {
    return vaultDoctor(rest);
  }
  console.error(unknownMessage("vault action", action ?? "", ["init", "sync", "doctor", "config"]));
  return { code: 1 };
}

async function vaultConfig(args: string[]): Promise<CliResult> {
  const [subcommand, pluginId] = args;

  if (subcommand === "bless") {
    if (!pluginId) {
      console.error("missing required argument: plugin");
      return { code: 1 };
    }
    const vaultPath = resolve(".");
    const result = await blessPlugin(vaultPath, pluginId);
    if (result.status === "blessed") {
      console.log(`blessed: ${result.plugin}`);
    } else {
      console.error(result.message ?? `${result.status}: ${result.plugin}`);
    }
    return { code: result.status === "blessed" ? 0 : 1 };
  }

  if (subcommand === "reset") {
    if (!pluginId) {
      console.error("missing required argument: plugin");
      return { code: 1 };
    }
    const vaultPath = resolve(".");
    const result = await resetPlugin(vaultPath, pluginId);
    if (result.status === "reset") {
      console.log(`reset: ${result.plugin} (source: ${result.source})`);
    } else {
      console.error(result.message ?? `${result.status}: ${result.plugin}`);
    }
    return { code: result.status === "reset" ? 0 : 1 };
  }

  console.error(`unknown config subcommand: ${subcommand ?? ""}`.trim());
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

async function vaultSync(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["plugin-source"]);
  const rawPath = parsed.positionals[0];
  if (rawPath === undefined) {
    console.error("missing required argument: path");
    return { code: 1 };
  }

  const vaultPath = resolve(rawPath);
  const repoRoot = resolveRepoRoot();
  const pluginSource = stringValue(parsed.values, "plugin-source");
  const result = await syncVault(
    vaultPath,
    repoRoot,
    pluginSource !== undefined ? { pluginSource } : undefined,
  );

  if (result.plugins.installed.length > 0) {
    console.log("plugins installed:");
    for (const id of result.plugins.installed) {
      console.log(`  ${id}`);
    }
  }
  if (result.plugins.skipped.length > 0) {
    console.log("plugins skipped (up to date):");
    for (const id of result.plugins.skipped) {
      console.log(`  ${id}`);
    }
  }
  if (result.configs.written.length > 0) {
    console.log("configs written:");
    for (const id of result.configs.written) {
      console.log(`  ${id}`);
    }
  }
  if (result.configs.skipped.length > 0) {
    console.log("configs skipped (already exist):");
    for (const id of result.configs.skipped) {
      console.log(`  ${id}`);
    }
  }
  console.log(`templates deployed: ${result.templates.count}`);

  return { code: 0 };
}

async function vaultDoctor(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const rawPath = parsed.positionals[0] ?? ".";
  const vaultPath = resolve(rawPath);
  const repoRoot = resolveRepoRoot();

  const result = await runDoctor(vaultPath, repoRoot);

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
