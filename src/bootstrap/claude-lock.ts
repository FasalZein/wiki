import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClaudeLockResult = {
  status: "installed" | "already-present" | "not-found";
  message?: string;
};

function denyPatterns(vaultPath: string): string[] {
  return [
    `Edit: ${vaultPath}/**`,
    `Write: ${vaultPath}/**`,
    `Bash: *${vaultPath}*`,
  ];
}

function resolveConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function hasVaultDenyPatterns(settings: Record<string, unknown>, vaultPath: string): boolean {
  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (!permissions) return false;
  const deny = permissions.deny as string[] | undefined;
  if (!deny || !Array.isArray(deny)) return false;

  const required = denyPatterns(vaultPath);
  return required.every((p) => deny.includes(p));
}

export async function installClaudeLock(vaultPath: string): Promise<ClaudeLockResult> {
  const configDir = resolveConfigDir();

  if (!(await dirExists(configDir))) {
    const patterns = denyPatterns(vaultPath);
    const snippet = JSON.stringify({ permissions: { deny: patterns } }, null, 2);
    return {
      status: "not-found",
      message:
        `Claude config directory not found at ${configDir}. ` +
        `Create it and add the following to settings.json:\n${snippet}`,
    };
  }

  const settingsPath = join(configDir, "settings.json");
  let settings: Record<string, unknown> = {};

  if (await dirExists(settingsPath)) {
    const raw = await readFile(settingsPath, "utf8");
    settings = JSON.parse(raw) as Record<string, unknown>;
  }

  if (hasVaultDenyPatterns(settings, vaultPath)) {
    return { status: "already-present" };
  }

  // Ensure permissions.deny exists
  if (!settings.permissions) {
    settings.permissions = {};
  }
  const permissions = settings.permissions as Record<string, unknown>;
  if (!Array.isArray(permissions.deny)) {
    permissions.deny = [];
  }
  const deny = permissions.deny as string[];

  // Add only missing patterns
  for (const pattern of denyPatterns(vaultPath)) {
    if (!deny.includes(pattern)) {
      deny.push(pattern);
    }
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { status: "installed" };
}
