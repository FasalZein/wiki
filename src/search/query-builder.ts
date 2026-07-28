import type { SearchIntent } from "./intent";
import { normalizeForSemantic } from "./normalize";

/**
 * Build a structured query document for QMD based on the classified intent.
 *
 * The document uses QMD's multi-line query format with intent/lex/vec/hyde lines.
 */
export function buildStructuredQuery(
  query: string,
  options: { intent: SearchIntent; project?: string; vocabulary?: readonly string[]; rationaleKinds?: readonly string[] },
): string {
  const lines: string[] = [];

  // Intent line with optional project context
  const intentDescription = describeIntent(options.intent, options.project, options.rationaleKinds ?? []);
  lines.push(`intent: ${intentDescription}`);

  // Lex line: tightened for location intents, raw for others
  lines.push(`lex: ${options.intent === "location" ? buildLocationLex(query, options.vocabulary ?? []) : query}`);

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
function buildLocationLex(query: string, vocabulary: readonly string[]): string {
  const normalizedQuestion = query.toLowerCase();
  const baseTerms = query
    .split(/[^a-z0-9-]+/iu)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token.toLowerCase()));

  // ADR-0047: the hint was a literal `prd -> prd spec specs` branch, which fired
  // for vaults with no prd kind and never fired for a vault's own kinds. Now the
  // active vocabulary (kind names + folders) supplies it: a query naming one of
  // this vault's kinds gets that term added, and a vault whose kinds go unmentioned
  // gets no hint at all.
  const hints = vocabulary.filter((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "u").test(normalizedQuestion));

  const terms = [...baseTerms, ...hints];
  const deduped = terms.filter((term, index) => terms.indexOf(term) === index);
  return deduped.join(" ").trim() || query;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeIntent(intent: SearchIntent, project: string | undefined, rationaleKinds: readonly string[]): string {
  const projectClause = project !== undefined ? ` about project ${project}` : "";

  switch (intent) {
    case "location":
      return `Answer a question${projectClause}. Prefer spec indexes and folder layouts.`;
    case "rationale":
      // ADR-0047: name the kinds THIS vault declares as rationale answers
      // (`search_intent` in wiki.json). A vault declaring none gets no ranking
      // instruction rather than a preference for kinds it does not have.
      return rationaleKinds.length === 0
        ? `Answer a question${projectClause}.`
        : `Answer a question${projectClause}. Prefer ${rationaleKinds.join(" and ")} artifacts.`;
    case "implementation":
      return `Answer a question${projectClause}. Prefer source code and implementation docs.`;
    case "temporal":
      return `Answer a question${projectClause}. Prefer changelogs and recent activity.`;
    case "general":
      return `Answer a question${projectClause}.`;
  }
}
