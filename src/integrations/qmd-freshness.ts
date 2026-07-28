/**
 * "Has anything changed since qmd last indexed this project?" — the local answer
 * to the question `qmd update` otherwise costs ~1.6s to answer remotely.
 *
 * The dedup gate refreshes the project's collection before querying so a
 * just-written artifact is visible. On a warm vault that update almost always
 * reports "0 new, 0 updated" — a subprocess spawned to discover that nothing
 * happened. This module answers the same question from the filesystem in ~5ms:
 * the newest `.md` mtime in the project, compared against a marker recording the
 * newest mtime present the last time we ran (or fired) an update.
 *
 * The marker lives in the user's cache dir, NOT the vault: the vault is
 * git-tracked, and a per-write marker inside it would produce a commit on every
 * create.
 *
 * Failure is always biased toward doing the work: an unreadable marker, an
 * unwritable cache dir, or a walk error all report "stale", so the caller runs
 * the update it would have run before this optimization existed.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { homeDir } from "../util";

/** Cache root: $XDG_CACHE_HOME/wiki/qmd, else ~/.cache/wiki/qmd. */
function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homeDir(), ".cache");
  return join(base, "wiki", "qmd");
}

/**
 * One marker per (vault, project). The project path is encoded rather than
 * nested so two vaults holding a same-named project never share a marker.
 */
function markerPath(projectPath: string): string {
  return join(cacheDir(), `${encodeURIComponent(projectPath)}.updated`);
}

/**
 * Newest mtime (epoch ms) among the project's markdown files, or 0 when the
 * project has none. Directories that vanish mid-walk are skipped — a concurrent
 * writer must not turn a freshness check into a failed create.
 */
export async function newestMarkdownMtime(projectPath: string): Promise<number> {
  let newest = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      try {
        const info = await stat(full);
        if (info.mtimeMs > newest) newest = info.mtimeMs;
      } catch {
        // Raced with a delete — nothing to date.
      }
    }
  };
  await walk(projectPath);
  return newest;
}

/** The mtime high-water mark qmd is known to have indexed, or 0 when unknown. */
async function readMarker(projectPath: string): Promise<number> {
  try {
    const raw = await readFile(markerPath(projectPath), "utf8");
    const value = Number.parseFloat(raw.trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Record the mtime high-water mark an update has covered. Best-effort. */
export async function writeMarker(projectPath: string, mtime: number): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(markerPath(projectPath), String(mtime), "utf8");
  } catch {
    // No cache dir (read-only home, sandbox) — the next check reports stale and
    // the update runs, which is exactly the pre-optimization behavior.
  }
}

/**
 * True when the project has markdown newer than the last update we recorded —
 * i.e. an update is worth spawning. Returns the observed high-water mark so the
 * caller can record it after (or alongside) the update it performs.
 */
export async function indexStaleness(projectPath: string): Promise<{ stale: boolean; newest: number }> {
  const [newest, marker] = await Promise.all([newestMarkdownMtime(projectPath), readMarker(projectPath)]);
  return { stale: newest > marker, newest };
}
