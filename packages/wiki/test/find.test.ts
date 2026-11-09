import assert from "node:assert/strict";
import { test } from "node:test";
import { literalTokens, noteDigest, planFind, selectMatches, type CurrentNoteReader, type FindPlanInput } from "../src/find.ts";
import { searchReport, type SearchOutcome } from "../src/search.ts";
import type { QmdFindResult, QmdSyncResult } from "../src/qmd.ts";

// In-process table tests of the find pipeline after retrieval (AC15) and of the search report (AC13).
// No SDK, model, vault or process: hits, captured inventory and current files are plain data.
const note = (type: string, title: string, body: string) => "---\ntype: " + type + "\ntitle: " + title + "\ndescription: " + title + " description\n---\n# " + title + "\n\n" + body + "\n";
const A = "projects/alpha/notes/a.md", B = "projects/alpha/notes/b.md", C = "projects/beta/decisions/c.md", P = "personal/notes/p.md";
const captured = new Map([
  [A, note("note", "Alpha A", "cache line in a")],
  [B, note("note", "Alpha B", "cache line in b mentions docs/guide.md")],
  [C, note("decision", "Beta C", "cache decision")],
  [P, note("note", "Personal", "personal cache")],
]);
function input(over: Partial<FindPlanInput>): FindPlanInput {
  return { hits: [], unmapped: [], captured, indexed: captured, question: "cache", queries: [{ type: "lex", query: "cache" }], ...over };
}
/** The current files equal the captured ones unless a test overrides a path. */
function reader(overrides: Record<string, string | undefined> = {}): CurrentNoteReader & { reads: string[] } {
  const reads: string[] = [];
  return { reads, digest(path) { reads.push(path); if (path in overrides) return overrides[path]; const markdown = captured.get(path); return markdown === undefined ? undefined : noteDigest(markdown); } };
}
const order = (over: Partial<FindPlanInput>) => planFind(input(over)).ordered.map(c => [c.path, c.score, c.literal.join(" ")]);

test("wiki:13 planFind orders, collapses and filters candidates before the limit", () => {
  const cases: { name: string; over: Partial<FindPlanInput>; expected: [string, number | null, string][] }[] = [
    { name: "qmd score descending", over: { hits: [{ path: A, score: 0.2 }, { path: C, score: 0.9 }, { path: B, score: 0.5 }] }, expected: [[C, 0.9, ""], [B, 0.5, ""], [A, 0.2, ""]] },
    { name: "equal scores break ties by canonical path", over: { hits: [{ path: P, score: 0.5 }, { path: C, score: 0.5 }, { path: A, score: 0.5 }] }, expected: [[P, 0.5, ""], [A, 0.5, ""], [C, 0.5, ""]] },
    { name: "a repeated path keeps its best-ranked entry", over: { hits: [{ path: A, score: 0.1 }, { path: B, score: 0.4 }, { path: A, score: 0.8 }] }, expected: [[A, 0.8, ""], [B, 0.4, ""]] },
    { name: "a literal-only note comes first with score null", over: { question: "docs/guide.md", hits: [{ path: A, score: 0.9 }] }, expected: [[B, null, "docs/guide.md"], [A, 0.9, ""]] },
    { name: "a literal match keeps its qmd score and moves ahead of better qmd hits", over: { question: "docs/guide.md", hits: [{ path: A, score: 0.9 }, { path: B, score: 0.1 }] }, expected: [[B, 0.1, "docs/guide.md"], [A, 0.9, ""]] },
    { name: "literal matches order by qmd rank, then path", over: { question: "projects/alpha/notes", hits: [{ path: C, score: 0.9 }, { path: B, score: 0.3 }] }, expected: [[B, 0.3, "projects/alpha/notes"], [A, null, "projects/alpha/notes"], [C, 0.9, ""]] },
    { name: "--terms tokens also match literally", over: { question: "how is it cached", terms: "notes/p.md", hits: [] }, expected: [[P, null, "notes/p.md"]] },
    { name: "scope filter drops other scopes", over: { scope: "projects/alpha", hits: [{ path: C, score: 0.9 }, { path: P, score: 0.8 }, { path: A, score: 0.1 }] }, expected: [[A, 0.1, ""]] },
    { name: "personal scope", over: { scope: "personal", hits: [{ path: C, score: 0.9 }, { path: P, score: 0.8 }] }, expected: [[P, 0.8, ""]] },
    { name: "type filter uses the captured frontmatter type", over: { type: "decision", hits: [{ path: A, score: 0.9 }, { path: C, score: 0.1 }] }, expected: [[C, 0.1, ""]] },
    { name: "a hit outside the captured inventory passes the type filter for later omission", over: { type: "decision", hits: [{ path: "projects/alpha/notes/gone.md", score: 0.5 }] }, expected: [["projects/alpha/notes/gone.md", 0.5, ""]] },
  ];
  for (const { name, over, expected } of cases) assert.deepEqual(order(over), expected, name);
});

test("wiki:13 literal tokens are path-like or dotted filenames, never version strings", () => {
  const cases: [string, string[]][] = [
    ["see docs/guide.md and README.md", ["docs/guide.md", "README.md"]],
    ["printf.3 libssl.so.3 main.c++ .env", ["printf.3", "libssl.so.3", "main.c++", ".env"]],
    ["v1.2 1.2.3 v2.0.1-beta", []],
    ["(\"a/b\"), a/b.", ["a/b"]],
    ["plain words only . / ..", []],
  ];
  for (const [text, expected] of cases) assert.deepEqual(literalTokens(text), expected, text);
});

test("wiki:12 selectMatches revalidates in order, omits without retry, and stops reading at the limit", () => {
  const plan = (over: Partial<FindPlanInput>) => planFind(input({ hits: [{ path: A, score: 0.9 }, { path: B, score: 0.8 }, { path: C, score: 0.7 }, { path: P, score: 0.6 }], ...over }));
  const cases: { name: string; over?: Partial<FindPlanInput>; current?: Record<string, string | undefined>; limit: number; matches: string[]; omitted: [string, string][]; reads: string[] }[] = [
    { name: "limit applies after ordering", limit: 2, matches: [A, B], omitted: [], reads: [A, B] },
    { name: "a changed note yields its place", current: { [A]: "sha256:other" }, limit: 2, matches: [B, C], omitted: [[A, "Note changed after capture"]], reads: [A, B, C] },
    { name: "a vanished note yields its place", current: { [B]: undefined }, limit: 2, matches: [A, C], omitted: [[B, "Note disappeared after capture"]], reads: [A, B, C] },
    { name: "an indexed body other than the captured one is omitted without a read", over: { indexed: new Map([...captured, [A, "old"]]) }, limit: 1, matches: [B], omitted: [[A, "Indexed content differs from the captured revision"]], reads: [B] },
    { name: "a hit missing from the capture is omitted without a read", over: { hits: [{ path: "projects/alpha/notes/gone.md", score: 1 }, { path: A, score: 0.5 }] }, limit: 5, matches: [A], omitted: [["projects/alpha/notes/gone.md", "Indexed candidate is not in the current captured inventory"]], reads: [A] },
    { name: "unmapped engine hits are omitted first", over: { unmapped: ["qmd://concepts/unknown.md"] }, limit: 1, matches: [A], omitted: [["qmd://concepts/unknown.md", "Indexed candidate is not in the current captured inventory"]], reads: [A] },
    { name: "filters apply before the limit", over: { scope: "projects/beta" }, limit: 1, matches: [C], omitted: [], reads: [C] },
  ];
  for (const { name, over = {}, current = {}, limit, matches, omitted, reads } of cases) {
    const port = reader(current);
    const selected = selectMatches(plan(over), limit, port);
    assert.deepEqual(selected.matches.map(m => m.path), matches, name);
    assert.deepEqual(selected.omitted.map(o => [o.path, o.message.slice(0, omitted.find(([p]) => p === o.path)?.[1].length ?? 0)]), omitted, name);
    assert.deepEqual(port.reads, reads, name);
  }
});

test("wiki:13 a rendered match carries scope, type, captured digest and the literal or lexical excerpt", () => {
  const plan = planFind(input({ question: "docs/guide.md", hits: [{ path: C, score: 0.25 }] }));
  const { matches } = selectMatches(plan, 5, reader());
  assert.deepEqual(matches, [
    { path: B, scope: "projects/alpha", type: "note", score: null, literal: ["docs/guide.md"], digest: noteDigest(captured.get(B) ?? ""), title: "Alpha B", description: "Alpha B description", excerpt: "cache line in b mentions docs/guide.md" },
    { path: C, scope: "projects/beta", type: "decision", score: 0.25, literal: [], digest: noteDigest(captured.get(C) ?? ""), title: "Beta C", description: "Beta C description", excerpt: "cache decision" },
  ]);
});

// Report fixtures: one successful synchronization with complete text coverage and one pending embedding hash.
const synced: QmdSyncResult = { state: "successful", textCoverage: { state: "complete", inventoryCount: 4, inventoryDigest: "sha256:inventory" }, embeddingCoverage: { state: "pending", contentHashes: 1 }, update: {} as Extract<QmdSyncResult, { state: "successful" }>["update"] };
function found(over: Partial<Extract<QmdFindResult, { state: "successful" }>> = {}): QmdFindResult {
  return { state: "successful", mode: "fast", queries: [{ type: "lex", query: "cache" }, { type: "vec", query: "cache" }], rerank: false, literals: [], limit: 10, matches: [], omitted: [], indexMismatch: [], ...over };
}
const findOutcome = (find: QmdFindResult): SearchOutcome => ({ kind: "find", sync: synced, find, requested: "fast", filters: {} });

test("wiki:12 omitted candidates or a replaced index lower text coverage to incomplete for that request only", () => {
  const omitted = [{ path: A, message: "Note changed after capture" }];
  const mismatch = [{ path: B, message: "replaced" }];
  const cases: { name: string; find: QmdFindResult; state: string; diagnostics: unknown[] }[] = [
    { name: "nothing omitted", find: found(), state: "complete", diagnostics: [] },
    { name: "omitted", find: found({ omitted }), state: "incomplete", diagnostics: omitted },
    { name: "index mismatch first, then omissions", find: found({ omitted, indexMismatch: mismatch }), state: "incomplete", diagnostics: [...mismatch, ...omitted] },
  ];
  for (const { name, find, state, diagnostics } of cases) {
    const report = searchReport(findOutcome(find));
    const value = report.value as { ok: boolean; textCoverage: { state: string; diagnostics?: unknown[] }; diagnostics: unknown[] };
    assert.equal(report.failure, undefined, name);
    assert.equal(value.ok, true, name);
    assert.equal(value.textCoverage.state, state, name);
    assert.deepEqual(value.diagnostics, diagnostics, name);
    if (state === "incomplete") assert.deepEqual(value.textCoverage.diagnostics, diagnostics, name);
    assert.match(report.human, new RegExp("^Mode: fast \\(one typed lex/vec query, no expansion, no reranking\\)\\nText coverage: " + state + " "), name);
    assert.match(report.human, /Embedding coverage: incomplete \(1 content hashes pending\)\nNo matches\n$/, name);
  }
});

test("wiki:13 degraded lexical results carry their reason label, unavailable embedding coverage and a non-exhaustive miss", () => {
  const cases: [Extract<QmdFindResult, { state: "successful" }>["degraded"] & object, string][] = [
    [{ retrieval: "lexical", exhaustive: false, reason: "models-unavailable", diagnostics: [{ path: ".wiki/config.json#search.models.embed", message: "Not configured" }] }, "search models not ready"],
    [{ retrieval: "lexical", exhaustive: false, reason: "vector-failed", diagnostics: [{ path: ".wiki/search", message: "Vector/model search failed: x" }] }, "vector search failed"],
    [{ retrieval: "lexical", exhaustive: false, reason: "expansion-failed", diagnostics: [{ path: ".wiki/search", message: "no usable entries" }] }, "deep expansion failed; no reranking"],
  ];
  for (const [degraded, label] of cases) {
    const report = searchReport(findOutcome(found({ degraded, queries: [{ type: "lex", query: "cache" }] })));
    const value = report.value as { embeddingCoverage: unknown; degraded: unknown; diagnostics: unknown[] };
    assert.equal(report.human, "Mode: fast degraded: lexical only (" + label + "); a miss is not an exhaustive absence claim\nText coverage: complete (captured inventory, not a current-at-return guarantee)\nEmbedding coverage: unavailable\nNo degraded lexical matches (not exhaustive)\n", label);
    assert.deepEqual(value.embeddingCoverage, { state: "unavailable" }, label);
    assert.deepEqual(value.degraded, degraded, label);
    assert.deepEqual(value.diagnostics, degraded.diagnostics, label);
    assert.equal(report.stderr, degraded.diagnostics.map(d => d.path + ": " + d.message + "\n").join(""), label);
  }
});

test("wiki:12 failures map to one error code and message per stage", () => {
  const unavailableSync: QmdSyncResult = { state: "unavailable", code: "conflict", textCoverage: { state: "unavailable", diagnostics: [{ path: ".wiki/search", message: "busy" }] }, embeddingCoverage: { state: "unavailable" } };
  const cases: [string, SearchOutcome, "conflict" | "unavailable", string][] = [
    ["busy sync during find", { kind: "find", sync: unavailableSync, requested: "deep", filters: {} }, "conflict", "Search index writer is busy"],
    ["sync unavailable", { kind: "sync", sync: { ...unavailableSync, code: "unavailable" } }, "unavailable", "Search synchronization unavailable"],
    ["find unavailable", findOutcome({ state: "unavailable", code: "unavailable", diagnostics: [{ path: ".wiki/search", message: "x" }] }), "unavailable", "Search find unavailable"],
    ["embed failed", { kind: "embed", sync: synced, embed: { state: "failed", code: "unavailable", embeddingCoverage: { state: "unavailable" }, diagnostics: [{ path: ".wiki/search", message: "x" }] } }, "unavailable", "Embedding synchronization failed"],
    ["models not ready for sync --embed", { kind: "models-unavailable", diagnostics: [{ path: ".wiki/config.json#search.models.embed", message: "Not configured" }] }, "unavailable", "Search models are not ready; configure existing local files (no download or hosted inference is attempted)"],
  ];
  for (const [name, outcome, code, message] of cases) {
    const report = searchReport(outcome);
    const value = report.value as { ok: boolean; error: { code: string; message: string } };
    assert.equal(report.failure, code, name);
    assert.equal(value.ok, false, name);
    assert.deepEqual(value.error, { code, message }, name);
    assert.ok(report.stderr.startsWith(code + ": " + message + "\n"), name);
  }
});
