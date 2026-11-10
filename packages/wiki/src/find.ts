import { parseNoteText } from "./frontmatter.ts";
import { sha256 } from "./vault.ts";
import type { QmdDiagnostic, QmdQuery, QmdRenderedMatch } from "./qmd.ts";

/* The find pipeline after retrieval (AC15). The search session gathers engine hits under its lock
 * (step a); planFind orders them with the captured inventory and filters, without IO (step b);
 * selectMatches revalidates each planned candidate against the current file through a one-method
 * read port until the limit is reached (step c). Nothing here touches the file system or the SDK. */

/** One engine hit already mapped from its staged id to a canonical path. score: the qmd score. */
export type FindHit = { path: string; score: number };
export type FindPlanInput = {
  /** Engine hits in engine order; a path may repeat. */
  hits: readonly FindHit[];
  /** Engine file ids without a staged identity, in engine order. */
  unmapped: readonly string[];
  /** The captured inventory this request synchronized: canonical path to Markdown. */
  captured: ReadonlyMap<string, string>;
  /** The active indexed body of each hit or captured path, read under the same lock. */
  indexed: ReadonlyMap<string, string>;
  question: string;
  terms?: string;
  /** The queries that produced the hits; lexical ones choose the excerpt line. */
  queries: readonly QmdQuery[];
  scope?: "personal" | `projects/${string}`;
  type?: string;
};
/** score: null when only literal matching found the note. literal: matched path-like tokens. */
type FindCandidate = { path: string; score: number | null; literal: string[] };
type FindPlan = {
  literals: string[];
  /** Filtered and ordered, before the limit: literal matches first, then qmd rank, then path. */
  ordered: FindCandidate[];
  /** Omissions known before any file read (unmapped engine hits). */
  omitted: QmdDiagnostic[];
  captured: ReadonlyMap<string, string>;
  indexed: ReadonlyMap<string, string>;
  queries: readonly QmdQuery[];
};
/** The read port of step (c): the sha256 digest of the current regular file at a canonical path,
 * or undefined when it is missing, not a regular file or unreadable. */
export type CurrentNoteReader = { digest(path: string): string | undefined };

// Surrounding quotes, brackets and sentence punctuation are not part of a path-like token.
const TOKEN_EDGES = /^["'`([{<]+|["'`)\]}>.,;:!?]+$/g;
// Version strings (v1.2, 1.2.3, v2.0.1-beta) look dotted but are not filenames.
const VERSION = /^[vV]?\d+(?:\.\d+)+(?:[-+][\w.+-]*)?$/;
/** A filename-like stem (empty for dotfiles such as .env) and one or more nonempty extension
 * segments of any characters: README.md, printf.3, libssl.so.3, main.c++. */
function dottedFilename(token: string): boolean {
  const segments = token.split(".");
  return segments.length > 1 && segments.slice(1).every(Boolean) && /\p{L}/u.test(token) && !VERSION.test(token);
}
/** Path-like tokens (containing "/" or a dotted filename form), in first-appearance order. */
export function literalTokens(text: string): string[] {
  const tokens = text.split(/\s+/).map(token => token.replace(TOKEN_EDGES, ""))
    .filter(token => /[\p{L}\p{N}]/u.test(token) && (token.includes("/") || dottedFilename(token)));
  return [...new Set(tokens)];
}
function comparePaths(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function typeOf(markdown: string): unknown {
  try { return parseNoteText(markdown).frontmatter.type; } catch { return undefined; }
}

/** Step (b). qmd order by score with canonical path tiebreak; a path keeps its best-ranked entry.
 * Literal tokens are plain substrings of canonical paths and captured note text (never regex,
 * shell or FTS syntax); a literal-only note gets score null. Scope and type filters apply here,
 * before the limit. */
export function planFind(input: FindPlanInput): FindPlan {
  const omitted = input.unmapped.map(file => ({ path: file, message: "Indexed candidate is not in the current captured inventory (deleted, renamed or out of scope); omitted" }));
  const literals = literalTokens(input.question + (input.terms === undefined ? "" : "\n" + input.terms));
  const ranked = [...input.hits].sort((a, b) => b.score - a.score || comparePaths(a.path, b.path));
  const candidates = new Map<string, FindCandidate & { rank: number }>();
  for (const [rank, hit] of ranked.entries()) if (!candidates.has(hit.path)) candidates.set(hit.path, { path: hit.path, score: hit.score, rank, literal: [] });
  if (literals.length) for (const [relative, markdown] of input.captured) {
    const literal = literals.filter(token => relative.includes(token) || markdown.includes(token));
    if (!literal.length) continue;
    const existing = candidates.get(relative);
    if (existing) existing.literal = literal;
    else candidates.set(relative, { path: relative, score: null, rank: Infinity, literal });
  }
  const inScope = (relative: string) => input.scope === undefined || relative.startsWith(input.scope + "/");
  // A candidate outside the captured inventory has no type; selectMatches reports its omission.
  const ofType = (relative: string) => input.type === undefined || !input.captured.has(relative) || typeOf(input.captured.get(relative) ?? "") === input.type;
  const ordered = [...candidates.values()].filter(c => inScope(c.path) && ofType(c.path))
    .sort((a, b) => Number(!a.literal.length) - Number(!b.literal.length) || a.rank - b.rank || comparePaths(a.path, b.path))
    .map(({ path, score, literal }) => ({ path, score, literal }));
  return { literals, ordered, omitted, captured: input.captured, indexed: input.indexed, queries: input.queries };
}

/** The first line containing a matched literal token, else the first line containing a lexical term. */
function excerptOf(body: string, queries: readonly QmdQuery[], literal: readonly string[]): string {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const terms = queries.filter(q => q.type === "lex").flatMap(q => q.query.toLowerCase().split(/\s+/)).filter(Boolean);
  return lines.find(line => literal.some(token => line.includes(token)))
    ?? lines.find(line => terms.some(term => line.toLowerCase().includes(term))) ?? lines[0] ?? "";
}
/** Every field comes from the captured revision. */
function renderMatch(candidate: FindCandidate, markdown: string, digest: string, queries: readonly QmdQuery[]): QmdRenderedMatch {
  let title = "", description = "", type = "", body = markdown;
  try {
    const parsed = parseNoteText(markdown);
    body = parsed.body;
    if (typeof parsed.frontmatter.title === "string") title = parsed.frontmatter.title;
    if (typeof parsed.frontmatter.description === "string") description = parsed.frontmatter.description;
    if (typeof parsed.frontmatter.type === "string") type = parsed.frontmatter.type;
  } catch { /* Captured concepts are lint-valid; keep raw text if not. */ }
  // Captured concepts are validated personal/<folder> or projects/<project>/<folder> paths.
  const scope = candidate.path.startsWith("personal/") ? "personal" : candidate.path.split("/").slice(0, 2).join("/");
  return { path: candidate.path, scope, type, score: candidate.score, literal: candidate.literal, digest, title, description, excerpt: excerptOf(body, queries, candidate.literal) };
}

/** Step (c). Walks the plan in order until limit matches: a candidate missing from the captured
 * inventory, indexed with other bytes, or changed on disk since capture is omitted with a
 * diagnostic, never retried, and the next candidate takes its place. Only vault files are read,
 * and only through the reader. beforeEach: the caller's cancellation check. */
export function selectMatches(plan: FindPlan, limit: number, reader: CurrentNoteReader, beforeEach: () => void = () => {}): { matches: QmdRenderedMatch[]; omitted: QmdDiagnostic[] } {
  const matches: QmdRenderedMatch[] = [], omitted = [...plan.omitted];
  for (const candidate of plan.ordered) {
    if (matches.length === limit) break;
    beforeEach();
    const markdown = plan.captured.get(candidate.path);
    if (markdown === undefined) { omitted.push({ path: candidate.path, message: "Indexed candidate is not in the current captured inventory (deleted, renamed or out of scope); omitted" }); continue; }
    if (plan.indexed.get(candidate.path) !== markdown) { omitted.push({ path: candidate.path, message: "Indexed content differs from the captured revision; omitted rather than attaching an old excerpt" }); continue; }
    const expected = sha256(markdown);
    const current = reader.digest(candidate.path);
    if (current !== expected) { omitted.push({ path: candidate.path, message: (current === undefined ? "Note disappeared" : "Note changed") + " after capture (moving target); omitted, not retried. Search again for its current revision" }); continue; }
    matches.push(renderMatch(candidate, markdown, expected, plan.queries));
  }
  return { matches, omitted };
}
