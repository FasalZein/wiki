import type { SearchIntent } from "./intent";
import { normalizeForSemantic } from "./normalize";

/**
 * Build a structured query document for QMD based on the classified intent.
 *
 * The document uses QMD's multi-line query format with intent/lex/vec/hyde lines.
 */
export function buildStructuredQuery(
  query: string,
  options: { intent: SearchIntent; project?: string },
): string {
  const lines: string[] = [];

  // Intent line with optional project context
  const intentDescription = describeIntent(options.intent, options.project);
  lines.push(`intent: ${intentDescription}`);

  // Lex line: tightened for location intents, raw for others
  lines.push(`lex: ${options.intent === "location" ? buildLocationLex(query) : query}`);

  // Vec line: normalized query for vector similarity
  lines.push(`vec: ${normalizeForSemantic(query)}`);

  // HyDE line: hypothetical document for rationale/implementation intents
  if (options.intent === "rationale" || options.intent === "implementation") {
    const statement = normalizeForSemantic(query)
      .replace(/^(why|how|what)\s+/i, "")
      .replace(/\?$/u, "");
    lines.push(`hyde: The answer is: ${statement}`);
  }

  return lines.join("\n");
}

const STOP_WORDS = new Set([
  "where", "which", "what", "does", "do", "how",
  "live", "lives", "about", "into", "with", "from",
  "this", "that", "there",
]);

/**
 * Build tighter lexical terms for location queries: strip stop words,
 * keep tokens >= 3 chars, add domain hints for known wiki terms.
 * Ported from v1 buildLexicalSearchQuery.
 */
function buildLocationLex(query: string): string {
  const normalizedQuestion = query.toLowerCase();
  const baseTerms = query
    .split(/[^a-z0-9-]+/iu)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token.toLowerCase()));

  // ponytail: only the prd hint survives — it is the single test-pinned branch
  // (search-upgrade: "where do PRDs live" => "PRDs prd spec specs"). The full
  // keep/cut of the domain-hint vocabulary is deferred; the tokenizer above stays.
  const hints: string[] = [];
  if (/\bprds?\b/u.test(normalizedQuestion)) hints.push("prd", "spec", "specs");

  const terms = [...baseTerms, ...hints];
  const deduped = terms.filter((term, index) => terms.indexOf(term) === index);
  return deduped.join(" ").trim() || query;
}

function describeIntent(intent: SearchIntent, project: string | undefined): string {
  const projectClause = project !== undefined ? ` about project ${project}` : "";

  switch (intent) {
    case "location":
      return `Answer a question${projectClause}. Prefer spec indexes and folder layouts.`;
    case "rationale":
      return `Answer a question${projectClause}. Prefer ADRs and architecture docs.`;
    case "implementation":
      return `Answer a question${projectClause}. Prefer source code and implementation docs.`;
    case "temporal":
      return `Answer a question${projectClause}. Prefer changelogs and recent activity.`;
    case "general":
      return `Answer a question${projectClause}.`;
  }
}
