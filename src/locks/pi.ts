import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PiDenyRule =
  | {
      tool: "write" | "edit" | "multi_edit";
      path: string;
    }
  | {
      tool: "bash";
      path: string;
      patterns: string[];
    };

export type PiLockManifest = {
  kind: "wiki-vault-lock/pi";
  version: 1;
  vaultRoot: string;
  deny: PiDenyRule[];
};

export type PiLockValidation = {
  ok: boolean;
  messages: string[];
};

const BASH_PATTERNS = [">", ">>", "tee", "cat >", "heredoc"];

export function resolvePiLockPath(path: string): string {
  return resolve(expandHome(path));
}

export function buildPiLockManifest(vaultPath: string): PiLockManifest {
  const vaultRoot = resolvePiLockPath(vaultPath);
  const lockedPath = `${vaultRoot}/**`;
  return {
    kind: "wiki-vault-lock/pi",
    version: 1,
    vaultRoot,
    deny: [
      { tool: "write", path: lockedPath },
      { tool: "edit", path: lockedPath },
      { tool: "multi_edit", path: lockedPath },
      { tool: "bash", path: lockedPath, patterns: [...BASH_PATTERNS] },
    ],
  };
}

export async function installPiLockManifest(configPath: string, manifest: PiLockManifest): Promise<string> {
  const target = resolvePiLockPath(configPath);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(tempPath, target);
  } catch (error) {
    await rmTemp(tempPath);
    throw error;
  }
  return target;
}

export async function validatePiLockConfig(configPath: string, expected: PiLockManifest): Promise<PiLockValidation> {
  const target = resolvePiLockPath(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (isFileNotFound(error)) {
      return { ok: false, messages: [`Config missing: ${target}`] };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, messages: [`Invalid JSON: ${target}`] };
    }
    throw error;
  }

  const messages: string[] = [];
  if (!isRecord(parsed)) {
    return { ok: false, messages: ["Config is not a JSON object"] };
  }

  if (parsed.kind !== expected.kind) {
    messages.push(`Kind mismatch: expected ${expected.kind}`);
  }
  if (parsed.version !== expected.version) {
    messages.push(`Version mismatch: expected ${expected.version}`);
  }
  if (parsed.vaultRoot !== expected.vaultRoot) {
    messages.push(`Vault root mismatch: expected ${expected.vaultRoot}`);
  }

  const deny = Array.isArray(parsed.deny) ? parsed.deny : [];
  if (!Array.isArray(parsed.deny)) {
    messages.push("Deny rules missing or invalid");
  }
  for (const rule of expected.deny) {
    if (!hasDenyRule(deny, rule)) {
      messages.push(`Missing deny rule: ${rule.tool} ${rule.path}`);
    }
  }

  return { ok: messages.length === 0, messages };
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

function hasDenyRule(deny: unknown[], expected: PiDenyRule): boolean {
  return deny.some((rule) => denyRuleMatches(rule, expected));
}

function denyRuleMatches(rule: unknown, expected: PiDenyRule): boolean {
  if (!isRecord(rule) || rule.tool !== expected.tool || rule.path !== expected.path) {
    return false;
  }
  if (expected.tool !== "bash") {
    return true;
  }
  const patterns = rule.patterns;
  return Array.isArray(patterns) && BASH_PATTERNS.every((pattern) => patterns.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rmTemp(path: string): Promise<void> {
  await rm(path, { force: true });
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
