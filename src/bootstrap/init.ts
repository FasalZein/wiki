import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type VaultInitResult = {
  path: string;
  created: string[];
  skipped: string[];
};

const DIRS = [
  "projects",
  "_templates",
  ".obsidian",
  ".obsidian/plugins",
  ".wiki",
  ".wiki/blessed-config",
];

const GITIGNORE_CONTENT = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".smart-env/",
  ".obsidian/plugins/*/data.json.bak",
].join("\n") + "\n";

const EMPTY_LOCKFILE = JSON.stringify({ version: 1, plugins: {} }, null, 2) + "\n";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initVault(vaultPath: string, options?: { pluginSource?: string }): Promise<VaultInitResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Ensure the vault root itself exists
  await mkdir(vaultPath, { recursive: true });

  // Create directory tree
  for (const dir of DIRS) {
    const fullPath = join(vaultPath, dir);
    if (await exists(fullPath)) {
      skipped.push(dir);
    } else {
      await mkdir(fullPath, { recursive: true });
      created.push(dir);
    }
  }

  // Write .gitignore
  const gitignorePath = join(vaultPath, ".gitignore");
  if (await exists(gitignorePath)) {
    skipped.push(".gitignore");
  } else {
    await writeFile(gitignorePath, GITIGNORE_CONTENT);
    created.push(".gitignore");
  }

  // Git init
  const gitDir = join(vaultPath, ".git");
  if (await exists(gitDir)) {
    skipped.push(".git");
  } else {
    const proc = Bun.spawn(["git", "init"], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    created.push(".git");
  }

  // Write plugin lockfile
  const lockfilePath = join(vaultPath, ".wiki", "plugin-lock.json");
  if (await exists(lockfilePath)) {
    skipped.push(".wiki/plugin-lock.json");
  } else {
    await writeFile(lockfilePath, EMPTY_LOCKFILE);
    created.push(".wiki/plugin-lock.json");
  }

  return { path: vaultPath, created, skipped };
}
