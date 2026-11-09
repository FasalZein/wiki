import { inspectVault } from "./lint.ts";
import type { Registry } from "./registry.ts";
import { syncQmdText, syncAndFindQmd, syncAndEmbedQmd, qmdModelReadiness, FAST_ROLES, DEEP_ROLES, type QmdDegraded, type QmdDiagnostic, type QmdEmbedResult, type QmdEmbeddingCoverage, type QmdFindFilters, type QmdFindResult, type QmdInventory, type QmdReadyModels, type QmdSyncResult, type QmdTextCoverage } from "./qmd.ts";

/** One search command's complete report. failure: the error code that sets the exit status.
 * value: the JSON document; human and stderr: the text output. The CLI only prints it. */
export type SearchReport = { failure: "conflict" | "unavailable" | undefined; value: object; human: string; stderr: string };
/** A validated search command. find filters: scope and type already checked by the caller. */
export type SearchCommand =
  | { kind: "sync"; embed: boolean }
  | { kind: "find"; question: string; terms?: string; deep: boolean; filters: QmdFindFilters };
/** What the search session returned, in the shape the report reads. */
export type SearchOutcome =
  /** A sync or embed request whose models failed preflight; find degrades instead. */
  | { kind: "models-unavailable"; diagnostics: QmdDiagnostic[] }
  | { kind: "sync"; sync: QmdSyncResult }
  | { kind: "embed"; sync: QmdSyncResult; embed?: QmdEmbedResult }
  | { kind: "find"; sync: QmdSyncResult; find?: QmdFindResult; requested: "fast" | "deep"; filters: QmdFindFilters };

const DEGRADED_LABEL: Record<QmdDegraded["reason"], string> = { "models-unavailable": "search models not ready", "vector-failed": "vector search failed", "expansion-failed": "deep expansion failed; no reranking" };
type ReportedEmbedding = { state: "complete" } | { state: "incomplete"; contentHashes: number } | { state: "unavailable" };
function reported(coverage: QmdEmbeddingCoverage): ReportedEmbedding {
  return coverage.state === "pending" ? { state: "incomplete", contentHashes: coverage.contentHashes } : coverage;
}
function coverageText(text: QmdTextCoverage, coverage: ReportedEmbedding): string {
  return "Text coverage: " + text.state + " (captured inventory, not a current-at-return guarantee)\nEmbedding coverage: " + coverage.state +
    ("contentHashes" in coverage ? " (" + coverage.contentHashes + " content hashes pending)" : "") + "\n";
}
function busy(code: "conflict" | "unavailable", otherwise: string) { return { code, message: code === "conflict" ? "Search index writer is busy" : otherwise }; }
function lines(problems: readonly QmdDiagnostic[]): string { return problems.map(d => d.path + ": " + d.message).join("\n") + (problems.length ? "\n" : ""); }

/** The pure report of one search command (AC13, AC15). Coverage is request-scoped: a find that
 * omitted candidates or met a replaced index lowers text coverage to incomplete; a degraded find
 * reports embedding coverage unavailable and labels its reason. */
export function searchReport(outcome: SearchOutcome): SearchReport {
  if (outcome.kind === "models-unavailable") {
    const error = { code: "unavailable", message: "Search models are not ready; configure existing local files (no download or hosted inference is attempted)" };
    return { failure: "unavailable", value: { ok: false, error, readiness: "unavailable", diagnostics: outcome.diagnostics }, human: "", stderr: error.code + ": " + error.message + "\n" + outcome.diagnostics.map(d => d.path + ": " + d.message).join("\n") + "\n" };
  }
  const result = outcome.sync;
  const diagnostics = result.textCoverage.state === "complete" ? [] : result.textCoverage.diagnostics;
  const report = (failure: { code: "conflict" | "unavailable"; message: string } | undefined, textCoverage: QmdTextCoverage, embeddingCoverage: ReportedEmbedding, extra: object, human: string, problems: QmdDiagnostic[]): SearchReport => ({
    failure: failure?.code,
    value: { ok: !failure, ...(failure ? { error: failure } : {}), coverageBasis: "captured-inventory", textCoverage, embeddingCoverage, ...extra, diagnostics: problems },
    human, stderr: (failure ? failure.code + ": " + failure.message + "\n" : "") + lines(problems),
  });
  const synced = reported(result.embeddingCoverage);
  if (result.state === "unavailable") return report(busy(result.code, "Search synchronization unavailable"), result.textCoverage, synced, {}, coverageText(result.textCoverage, synced), diagnostics);
  if (outcome.kind === "sync") return report(undefined, result.textCoverage, synced, {}, coverageText(result.textCoverage, synced), diagnostics);
  if (outcome.kind === "embed") {
    // The session runs embedding whenever synchronization succeeded.
    const embedded = outcome.embed;
    if (!embedded) throw new Error("Embedding did not run after a successful synchronization");
    const coverage = reported(embedded.embeddingCoverage);
    if (embedded.state === "failed") return report(busy(embedded.code, "Embedding synchronization failed"), result.textCoverage, coverage, { embedding: "failed", ...(embedded.embedded ? { embedded: embedded.embedded } : {}) }, coverageText(result.textCoverage, coverage), [...diagnostics, ...embedded.diagnostics]);
    return report(undefined, result.textCoverage, coverage, { embedding: "complete", embedded: embedded.embedded }, coverageText(result.textCoverage, coverage), diagnostics);
  }
  const found = outcome.find;
  if (!found) throw new Error("Find did not run after a successful synchronization");
  if (found.state === "unavailable") return report(busy(found.code, "Search find unavailable"), result.textCoverage, synced, { mode: outcome.requested }, coverageText(result.textCoverage, synced), [...diagnostics, ...found.diagnostics]);
  // A replaced index or omitted candidates (deleted, renamed, stale index, moving target) make text coverage incomplete for this request.
  const coverageProblems = [...found.indexMismatch, ...found.omitted];
  const textCoverage: QmdTextCoverage = coverageProblems.length ? { state: "incomplete", diagnostics: [...diagnostics, ...coverageProblems] } : result.textCoverage;
  const coverage: ReportedEmbedding = found.degraded ? { state: "unavailable" } : synced;
  const label = found.degraded ? " degraded: lexical only (" + DEGRADED_LABEL[found.degraded.reason] + "); a miss is not an exhaustive absence claim"
    : found.mode === "deep" ? " (explicit expansion and reranking)" : " (one typed lex/vec query, no expansion, no reranking)";
  const { scope, type } = outcome.filters;
  return report(undefined, textCoverage, coverage, { mode: found.mode, queries: found.queries, rerank: found.rerank, ...(found.degraded ? { degraded: found.degraded } : {}), literals: found.literals, limit: found.limit, filters: { ...(scope ? { scope } : {}), ...(type ? { type } : {}) }, matches: found.matches },
    "Mode: " + found.mode + label + "\n" + coverageText(textCoverage, coverage) +
    (found.matches.length ? found.matches.map(m => m.path + " " + (m.score === null ? "literal" : m.score.toFixed(4)) + " " + m.digest + (m.literal.length ? " [literal: " + m.literal.join(" ") + "]" : "") + "\n  " + m.title + ": " + m.description + "\n  " + m.excerpt).join("\n") + "\n" : found.degraded ? "No degraded lexical matches (not exhaustive)\n" : "No matches\n"),
    [...diagnostics, ...coverageProblems, ...(found.degraded?.diagnostics ?? [])]);
}

/** Runs one search command against an opened vault and returns its report. Explicit local models
 * are preflighted before any index effect or SDK model use. */
export async function runSearch(root: string, command: SearchCommand, signal: AbortSignal, registry?: Registry): Promise<SearchReport> {
  const find = command.kind === "find" ? command : undefined;
  const embed = command.kind === "sync" && command.embed;
  const roles = find ? (find.deep ? DEEP_ROLES : FAST_ROLES) : embed ? FAST_ROLES : [];
  const readiness = qmdModelReadiness(root, roles);
  // Plain sync measures pending embeddings against a configured embed model when one is ready.
  const measured = roles.length ? readiness : qmdModelReadiness(root, FAST_ROLES);
  // Find stays usable without models: model-free lexical retrieval, labelled degraded.
  if (readiness.state === "unavailable" && !find) return searchReport({ kind: "models-unavailable", diagnostics: readiness.diagnostics });
  let captured: QmdInventory;
  try {
    const inventory = inspectVault(root, undefined, undefined, registry);
    captured = { concepts: inventory.concepts, diagnostics: inventory.diagnostics };
  } catch (error) {
    // An incomplete scan cannot reuse an earlier successful receipt.
    captured = { concepts: [], diagnostics: [{ path: "", message: error instanceof Error ? error.message : String(error) }] };
  }
  const syncOptions = { signal, ...(measured.state === "ready" ? { models: measured.models } : {}) };
  // One session: find and --embed synchronize text and then query or embed under one index lock.
  if (find) {
    const { question, terms, filters } = find;
    const requested = find.deep ? "deep" as const : "fast" as const;
    const outcome = await syncAndFindQmd(root, captured, syncOptions, readiness.state === "unavailable" ? { ...filters, mode: "lexical", requested, question, terms, reason: readiness.diagnostics }
      : find.deep ? { ...filters, mode: "deep", question, terms, models: readiness.models as QmdReadyModels<"embed" | "generate" | "rerank"> } // --deep preflighted DEEP_ROLES
      : { ...filters, mode: "fast", question, terms, models: readiness.models }, signal);
    return searchReport({ kind: "find", ...outcome, requested, filters });
  }
  if (embed && readiness.state === "ready") return searchReport({ kind: "embed", ...await syncAndEmbedQmd(root, captured, syncOptions, readiness.models, signal) });
  return searchReport({ kind: "sync", sync: await syncQmdText(root, captured, syncOptions) });
}
