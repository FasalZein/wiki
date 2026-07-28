/**
 * ProjectIndex — the single home for qmd command-resolution and the
 * ensure→refresh→query sequencing that dedup and the write path share.
 *
 * qmd.ts stays the thin subprocess adapter beneath; this module owns only the
 * two things every caller used to re-implement: (1) which binary to run —
 * QMD_COMMAND env → _project.md qmd_command → default "qmd" — resolved ONCE, and
 * (2) the order collections are registered, refreshed, and queried in.
 */

import {
  ensureCollection,
  refreshCollections,
  runQuery,
  runSearch,
  updateCollectionDetached,
  type QmdResult,
} from "./qmd";
import { indexStaleness, writeMarker } from "./qmd-freshness";
import type { ProjectConfig } from "../config/project";

/**
 * The one qmd command-resolution rule: QMD_COMMAND env, then the project's
 * _project.md qmd_command, then default "qmd". `config` is optional for callers
 * that resolve before any project config exists (e.g. `wiki project create`).
 */
export function resolveQmdCommand(config?: Pick<ProjectConfig, "qmd_command">): string {
  return process.env.QMD_COMMAND ?? config?.qmd_command ?? "qmd";
}

/**
 * Lazy variant for the best-effort write path: QMD_COMMAND pins the command
 * WITHOUT loading config; only when the env var is absent is `loadConfig`
 * awaited. This preserves the write path's "env skips config load" behavior — a
 * config-less project with QMD_COMMAND set still refreshes, and one without it
 * lets the load failure propagate so the caller skips the refresh.
 */
export async function resolveQmdCommandLazy(
  loadConfig: () => Promise<Pick<ProjectConfig, "qmd_command">>,
): Promise<string> {
  return process.env.QMD_COMMAND ?? (await loadConfig()).qmd_command;
}

/**
 * Resolve one qmd command for a vault-wide (multi-project) query: QMD_COMMAND
 * pins it; otherwise every targeted project must agree on qmd_command. Returns
 * the shared command, or the diverging value→project pairs so the caller can
 * render an actionable error.
 */
export function resolveSharedQmdCommand(
  configs: ReadonlyArray<readonly [string, Pick<ProjectConfig, "qmd_command">]>,
): { command: string } | { divergent: ReadonlyArray<readonly [string, string]> } {
  if (process.env.QMD_COMMAND !== undefined) {
    return { command: process.env.QMD_COMMAND };
  }
  const pairs = configs.map(([project, config]) => [project, config.qmd_command] as const);
  const first = pairs[0]?.[1];
  if (first !== undefined && pairs.every(([, value]) => value === first)) {
    return { command: first };
  }
  return { divergent: pairs };
}

export type ProjectIndex = {
  /** The resolved qmd command, cached at construction (no re-resolution). */
  readonly command: string;
  /** Register the project's collection if it isn't already (idempotent). */
  ensure(): Promise<void>;
  /** Incremental keyword refresh so a just-written artifact is queryable (no embed). */
  refresh(): Promise<void>;
  /**
   * {@link ProjectIndex.refresh}, skipped when no markdown in the project is
   * newer than the last refresh this machine recorded. The read path's freshness
   * requirement is "qmd has seen every file on disk" — a question the filesystem
   * answers in ~5ms and `qmd update` answers in ~1.6s.
   */
  refreshIfStale(): Promise<void>;
  /**
   * Fire the keyword refresh without awaiting it (write path). Returns
   * immediately; the detached child finishes after this process exits.
   */
  refreshDetached(): Promise<void>;
  /** Query this project's collection through the shared qmd query path. */
  query(document: string, options?: { explain?: boolean; limit?: number }): Promise<QmdResult[]>;
  /**
   * BM25-only retrieval over this project's collection (ADR-0047) — the dedup
   * gate's read. No vectors, no reranking, no expansion LLM.
   */
  search(terms: string, options?: { limit?: number }): Promise<QmdResult[]>;
};

/**
 * A per-(project, config) qmd orchestrator. Resolves the command once, then owns
 * the ensure→refresh→query sequence so single-project callers (dedup, the write
 * path) stop re-implementing it.
 */
export function projectIndex(input: {
  project: string;
  projectPath: string;
  config?: Pick<ProjectConfig, "qmd_command">;
}): ProjectIndex {
  const command = resolveQmdCommand(input.config);
  return {
    command,
    ensure: () => ensureCollection(command, input.project, input.projectPath),
    refresh: () => refreshCollections(command, [input.project]),
    refreshIfStale: async () => {
      const { stale, newest } = await indexStaleness(input.projectPath);
      if (!stale) return;
      await refreshCollections(command, [input.project]);
      await writeMarker(input.projectPath, newest);
    },
    refreshDetached: async () => {
      // Record the high-water mark BEFORE spawning: the mark covers what is on
      // disk now, which is what the child is about to index. If the child fails,
      // the next dedup gate skips an update it would have run — and the local
      // same-kind scan (dedup.ts) still sees the unindexed file, which is the
      // backstop that exists for exactly this case.
      const { newest } = await indexStaleness(input.projectPath);
      await writeMarker(input.projectPath, newest);
      updateCollectionDetached(command, input.project);
    },
    query: (document, options) => runQuery(command, document, [input.project], options),
    search: (terms, options) => runSearch(command, terms, [input.project], options),
  };
}
