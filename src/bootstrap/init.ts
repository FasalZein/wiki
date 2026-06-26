import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { exists } from "../util";

export type VaultInitResult = {
  path: string;
  created: string[];
  skipped: string[];
};

const DIRS = ["projects", ".wiki"];

const GITIGNORE_CONTENT = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".smart-env/",
].join("\n") + "\n";

export async function initVault(vaultPath: string): Promise<VaultInitResult> {
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

  return { path: vaultPath, created, skipped };
}
