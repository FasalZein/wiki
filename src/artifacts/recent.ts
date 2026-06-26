import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { ARTIFACT_FOLDERS } from "./registry";

/** Default count of recent artifacts shown by status and the recency search path. */
export const RECENT_LIMIT = 10;

export type RecentArtifact = { rel: string; full: string; mtime: number };

/**
 * Every artifact .md file across a project's kind folders, newest-modified first.
 * Shared by `status` (recent list) and `search --recent/--since` (mtime ordering)
 * so the two cannot drift on what "recent" means.
 */
export async function recentArtifacts(vaultRoot: string, projectPath: string): Promise<RecentArtifact[]> {
  const files: RecentArtifact[] = [];
  for (const folder of ARTIFACT_FOLDERS) {
    const dir = join(projectPath, folder);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const full = join(entry.parentPath, entry.name);
      const stats = await stat(full);
      files.push({ rel: relative(vaultRoot, full), full, mtime: stats.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}
