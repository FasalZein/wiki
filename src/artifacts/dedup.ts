import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { QmdError, type QmdResult } from "../integrations/qmd";
import { projectIndex } from "../integrations/project-index";
import type { ProjectConfig } from "../config/project";
import type { TemplateType } from "../schema/load";
import { classifyIntent } from "../search/intent";
import { buildStructuredQuery } from "../search/query-builder";
import { openArtifact } from "./artifact-file";
import { artifactFolder } from "./paths";
import type { Structure } from "./registry";

export type DedupThresholds = {
  weak: number;
  strong: number;
};

export type DedupOverride =
  | { kind: "none" }
  | { kind: "force-new"; reason: string }
  | { kind: "related-to"; id: string }
  | { kind: "supersedes"; id: string };

export type DedupResult = {
  path: string;
  score: number;
  strength: "possible" | "strong";
  /** Candidate artifact id (e.g. ADR-0012), read from the filename stem. */
  id: string;
  /** Candidate kind, inferred from the id prefix (undefined if unrecognized). */
  kind: TemplateType | undefined;
  /** Candidate title, read from frontmatter ("" when unreadable). */
  title: string;
  /** True when the candidate's kind equals the kind being created — the only
   *  class that can gate a create (ADR-0044). Cross-kind matches never block. */
  sameKind: boolean;
};

export type DedupGateInput = {
  type: TemplateType;
  project: string;
  projectPath: string;
  config: ProjectConfig;
  query: string;
  override: DedupOverride;
  structure: Structure;
};

export class DedupBlockedError extends Error {
  readonly matches: DedupResult[];
  readonly thresholds: DedupThresholds;
  readonly projectPath: string;

  constructor(matches: DedupResult[], thresholds: DedupThresholds, projectPath: string) {
    super("possible duplicate artifacts found");
    this.matches = matches;
    this.thresholds = thresholds;
    this.projectPath = projectPath;
  }
}

export { QmdError };

export async function runDedupGate(input: DedupGateInput): Promise<void> {
  if (input.override.kind !== "none") {
    return;
  }

  const thresholds = { weak: input.config.dedup_threshold_weak, strong: input.config.dedup_threshold_strong };

  const index = projectIndex({ project: input.project, projectPath: input.projectPath, config: input.config });
  await index.ensure();
  await index.refresh();
  // Route through the same structured-query path search uses so dedup and
  // search score against the identical intent/lex/vec document.
  const queryDocument = buildStructuredQuery(input.query, {
    intent: classifyIntent(input.query),
    project: input.project,
  });
  const qmdResults = thresholdResults(await index.query(queryDocument), thresholds);
  const qmdMatches = await Promise.all(
    qmdResults.map((result) => enrichMatch(result, input.projectPath, input.project, input.type, input.structure)),
  );

  // BUG-F (ADR-0044): also scan the target project's same-kind folder for
  // near-duplicates the last sync missed (a file created earlier this session with
  // no sync in between is not yet in the qmd index). Compares title+summary locally
  // — create stays pure, no index write. Merged with the qmd matches, deduped by id.
  const localMatches = await scanUnsyncedSameKind(input.type, input.projectPath, input.query, input.structure, thresholds);

  const merged = mergeById([...qmdMatches, ...localMatches]);
  if (merged.length > 0) {
    throw new DedupBlockedError(merged, thresholds, input.projectPath);
  }
}

export function parseDedupOverride(input: {
  forceNew: string | undefined;
  relatedTo: string | undefined;
  supersedes: string | undefined;
}): DedupOverride | string {
  const present = [input.forceNew, input.relatedTo, input.supersedes].filter((value) => value !== undefined);
  if (present.length > 1) {
    return "only one of --force-new, --related-to, or --supersedes may be used";
  }
  if (input.forceNew !== undefined) {
    if (input.forceNew.length < 30) {
      return "force-new reason must be at least 30 characters";
    }
    return { kind: "force-new", reason: input.forceNew };
  }
  if (input.relatedTo !== undefined) {
    return { kind: "related-to", id: input.relatedTo };
  }
  if (input.supersedes !== undefined) {
    return { kind: "supersedes", id: input.supersedes };
  }
  return { kind: "none" };
}

export function fieldsForDedupOverride(override: DedupOverride): Record<string, unknown> {
  if (override.kind === "force-new") {
    return { force_new_reason: override.reason };
  }
  if (override.kind === "related-to") {
    return { related: [override.id] };
  }
  if (override.kind === "supersedes") {
    return { supersedes: override.id };
  }
  return {};
}

/** One-line advisory for a same-kind match — no path, no snippet hunk (ADR-0044). */
export function formatSameKindAdvisory(match: DedupResult): string {
  return `dedup: ${match.strength} ${match.score.toFixed(2)} vs ${match.id} "${match.title}" — choose --supersedes / --related-to / --force-new`;
}

/** One non-blocking info line for a cross-kind overlap (ADR-0044). */
export function formatCrossKindNote(match: DedupResult): string {
  return `note: overlaps ${match.id} "${match.title}" (${match.kind ?? "unknown"}, ${match.score.toFixed(2)}) — cross-kind, not a duplicate`;
}

function thresholdResults(results: QmdResult[], thresholds: DedupThresholds): Array<{ path: string; score: number; strength: "possible" | "strong" }> {
  return results.flatMap((result) => {
    const score = Number.parseFloat(result.score);
    if (!Number.isFinite(score) || score < thresholds.weak) {
      return [];
    }
    return [{ path: result.path, score, strength: score >= thresholds.strong ? "strong" : "possible" }];
  });
}

/** Turn a raw scored qmd hit into a DedupResult: derive id from the filename, kind
 *  from the id prefix, title from frontmatter, and whether it is the same kind as
 *  the create. Never blocks on a read failure — a missing title falls back to "". */
async function enrichMatch(
  raw: { path: string; score: number; strength: "possible" | "strong" },
  projectPath: string,
  project: string,
  createKind: TemplateType,
  structure: Structure,
): Promise<DedupResult> {
  const filePath = resolveMatchFile(raw.path, projectPath, project);
  const id = idOfFile(filePath);
  const kind = structure.typeForId(id);
  const title = await readTitle(filePath);
  return { path: raw.path, score: raw.score, strength: raw.strength, id, kind, title, sameKind: kind === createKind };
}

/** Resolve a qmd://<collection>/<rel> URI (or raw fs path) to a file on disk. Dedup
 *  queries only the current project's collection, so <rel> is under projectPath. */
function resolveMatchFile(path: string, projectPath: string, project: string): string {
  if (path.startsWith("qmd://")) {
    const rest = path.slice("qmd://".length);
    const slash = rest.indexOf("/");
    const rel = slash === -1 ? rest : rest.slice(slash + 1);
    return join(projectPath, rel);
  }
  return path;
}

/** The artifact id a match points at — the filename's PREFIX-NNNN stem. */
function idOfFile(filePath: string): string {
  const stem = basename(filePath).replace(/\.md$/, "");
  return stem.match(/^([A-Za-z]+-\d+)/)?.[1] ?? stem;
}

async function readTitle(filePath: string): Promise<string> {
  try {
    return (await openArtifact(filePath)).field("title") ?? "";
  } catch {
    return "";
  }
}

/**
 * BUG-F: local same-kind near-duplicate scan (ADR-0044). Reads every artifact in
 * the create-kind's folder, scores its title+summary against the new artifact's
 * title+summary with a lexical cosine, and returns candidates over the weak
 * threshold — so a file created earlier this session (not yet in the qmd index)
 * still surfaces as a same-kind candidate. Pure read; create writes no index.
 * ponytail: scans the whole same-kind folder each create — fine for typical
 * project sizes; add an mtime cursor if a folder ever grows large enough to matter.
 */
async function scanUnsyncedSameKind(
  type: TemplateType,
  projectPath: string,
  query: string,
  structure: Structure,
  thresholds: DedupThresholds,
): Promise<DedupResult[]> {
  const dir = join(projectPath, artifactFolder(type, structure));
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];
  const files = await listMarkdown(dir);
  const out: DedupResult[] = [];
  for (const file of files) {
    let af;
    try {
      af = await openArtifact(file);
    } catch {
      continue;
    }
    const id = af.field("id");
    if (id === undefined) continue;
    const title = af.field("title") ?? "";
    const summary = af.field("summary") ?? "";
    const score = cosine(queryTokens, tokenize(`${title} ${summary}`));
    if (score >= thresholds.weak) {
      out.push({
        path: file,
        score,
        strength: score >= thresholds.strong ? "strong" : "possible",
        id,
        kind: type,
        title,
        sameKind: true,
      });
    }
  }
  return out;
}

/** Recursively list *.md files under a directory (branch kinds nest into buckets). */
async function listMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listMarkdown(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** Cosine similarity of two term-frequency vectors (0..1). Identical text → 1. */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [term, count] of a) {
    const other = b.get(term);
    if (other !== undefined) dot += count * other;
  }
  const magA = Math.sqrt([...a.values()].reduce((sum, n) => sum + n * n, 0));
  const magB = Math.sqrt([...b.values()].reduce((sum, n) => sum + n * n, 0));
  return magA === 0 || magB === 0 ? 0 : dot / (magA * magB);
}

/** Merge candidates from qmd + the local scan, keeping the highest score per id. */
function mergeById(matches: DedupResult[]): DedupResult[] {
  const byId = new Map<string, DedupResult>();
  for (const match of matches) {
    const existing = byId.get(match.id);
    if (existing === undefined || match.score > existing.score) byId.set(match.id, match);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
