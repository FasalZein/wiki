/**
 * Per-project "last embed" marker (F4). `wiki sync` stamps it after a successful
 * embed; `wiki search` compares artifact mtimes against it so an agent that wrote
 * artifacts but skipped `sync` gets told its vector recall may be stale — the write
 * path refreshes only the KEYWORD index (store.ts), so lexical hits are fresh while
 * vectors lag with no other signal. A plain sentinel file whose mtime is the stamp,
 * living beside the `.index-cache.json` sync already writes under the project.
 */

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { recentArtifacts } from "./recent";
import type { Structure } from "./registry";

const MARKER_FILE = ".last-embed";

/** Stamp the marker (mtime = now) — call only after a successful sync embed. */
export async function markEmbedded(projectPath: string): Promise<void> {
  await writeFile(join(projectPath, MARKER_FILE), "");
}

/**
 * How many artifacts under the project are newer than the last embed. Returns 0
 * when the marker is missing (never-synced is surfaced separately, so don't
 * double-warn) or nothing is newer. Reuses the recent.ts walk — stat-level work,
 * no file contents read — so it never measurably slows the read path.
 */
export async function countArtifactsNewerThanEmbed(
  vaultRoot: string,
  projectPath: string,
  structure: Structure,
): Promise<number> {
  let markerMtime: number;
  try {
    markerMtime = (await stat(join(projectPath, MARKER_FILE))).mtimeMs;
  } catch {
    return 0;
  }
  const artifacts = await recentArtifacts(vaultRoot, projectPath, structure);
  return artifacts.filter((artifact) => artifact.mtime > markerMtime).length;
}
