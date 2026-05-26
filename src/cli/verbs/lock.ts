import { buildPiLockManifest, installPiLockManifest, resolvePiLockPath, validatePiLockConfig } from "../../locks/pi";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleLock(args: string[]): Promise<CliResult> {
  const [target, action, ...rest] = args;
  if (target !== "pi") {
    console.error(`unknown lock target: ${target ?? ""}`.trim());
    return { code: 1 };
  }
  if (action === "print") {
    return printPiLock(rest);
  }
  if (action === "install") {
    return installPiLock(rest);
  }
  if (action === "check") {
    return checkPiLock(rest);
  }
  if (action === "doctor") {
    return doctorPiLock(rest);
  }
  console.error(`unknown lock pi action: ${action ?? ""}`.trim());
  return { code: 1 };
}

async function printPiLock(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["vault"]);
  const vault = requiredString(parsed.values, "vault");
  if (vault === undefined) {
    return { code: 1 };
  }
  console.log(JSON.stringify(buildPiLockManifest(vault), null, 2));
  return { code: 0 };
}

async function installPiLock(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["vault", "config"]);
  const vault = requiredString(parsed.values, "vault");
  const config = requiredString(parsed.values, "config");
  if (vault === undefined || config === undefined) {
    return { code: 1 };
  }
  const target = await installPiLockManifest(config, buildPiLockManifest(vault));
  console.log(target);
  return { code: 0 };
}

async function checkPiLock(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["vault", "config"]);
  const vault = requiredString(parsed.values, "vault");
  const config = requiredString(parsed.values, "config");
  if (vault === undefined || config === undefined) {
    return { code: 1 };
  }
  const validation = await validatePiLockConfig(config, buildPiLockManifest(vault));
  if (!validation.ok) {
    for (const message of validation.messages) {
      console.error(message);
    }
    return { code: 1 };
  }
  return { code: 0 };
}

async function doctorPiLock(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["vault", "config"]);
  const vault = requiredString(parsed.values, "vault");
  const config = requiredString(parsed.values, "config");
  if (vault === undefined || config === undefined) {
    return { code: 1 };
  }
  const expected = buildPiLockManifest(vault);
  const validation = await validatePiLockConfig(config, expected);
  if (validation.ok) {
    console.log("Vault lock: OK");
    console.log(`Config: ${resolvePiLockPath(config)}`);
    console.log(`Vault: ${expected.vaultRoot}`);
    return { code: 0 };
  }
  console.log("Vault lock: FAIL");
  for (const message of validation.messages) {
    console.log(message);
  }
  return { code: 1 };
}

function requiredString(values: Record<string, string | boolean | string[] | undefined>, name: string): string | undefined {
  const value = stringValue(values, name);
  if (value === undefined) {
    console.error(`missing required field: ${name}`);
  }
  return value;
}
