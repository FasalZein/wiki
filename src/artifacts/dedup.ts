import { relative } from "node:path";

import { ensureCollection, QmdError, runQuery, type QmdResult } from "../integrations/qmd";
import type { ProjectConfig } from "../config/project";

export type DedupArtifactType = "decision" | "prd" | "slice";

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
  snippet: string;
  strength: "possible" | "strong";
};

export type DedupGateInput = {
  type: DedupArtifactType;
  project: string;
  projectPath: string;
  config: ProjectConfig;
  query: string;
  override: DedupOverride;
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

  const qmdCommand = process.env.QMD_COMMAND ?? input.config.qmd_command;
  await ensureCollection(qmdCommand, input.project, input.projectPath);
  const results = thresholdResults(
    await runQuery(qmdCommand, input.query, [input.project]),
    { weak: input.config.dedup_threshold_weak, strong: input.config.dedup_threshold_strong },
  );
  if (results.length > 0) {
    throw new DedupBlockedError(results, {
      weak: input.config.dedup_threshold_weak,
      strong: input.config.dedup_threshold_strong,
    }, input.projectPath);
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

export function formatDedupBlocked(error: DedupBlockedError): string {
  const lines = [
    `possible duplicate artifacts found (weak >= ${formatThreshold(error.thresholds.weak)}, strong >= ${formatThreshold(error.thresholds.strong)}):`,
  ];
  for (const match of error.matches) {
    lines.push(
      `- ${match.strength} ${relative(error.projectPath, match.path)} (score: ${formatScore(match.score)})`,
      `  ${match.snippet.replaceAll(/\s*\n\s*/g, " ").trim()}`,
    );
  }
  lines.push("choose one: --supersedes <id>, --related-to <id>, or --force-new \"reason at least 30 characters\"");
  return lines.join("\n");
}

function thresholdResults(results: QmdResult[], thresholds: DedupThresholds): DedupResult[] {
  return results.flatMap((result) => {
    const score = Number.parseFloat(result.score);
    if (!Number.isFinite(score) || score < thresholds.weak) {
      return [];
    }
    return [
      {
        path: result.path,
        score,
        snippet: result.snippet,
        strength: score >= thresholds.strong ? "strong" : "possible",
      },
    ];
  });
}

function formatThreshold(value: number): string {
  return value.toFixed(2);
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
