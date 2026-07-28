export type SearchIntent = "location" | "rationale" | "implementation" | "temporal" | "general";

/** Container words that mean "where does this live" in any vault, whatever its
 *  kinds are called. The kind-specific half of this vocabulary comes from the
 *  active Structure (ADR-0047), not from literals. */
const LOCATION_NOUNS = "file|files|doc|docs|page|pages|module|modules|task|tasks|folder|folders|route|routes";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classify the query's intent to determine the query strategy.
 *
 * Order matters: location and temporal are checked first as guards,
 * then rationale, then implementation, then default to general.
 *
 * ADR-0047: `vocabulary` carries the active vault's kind/folder names. Omitting
 * it classifies on container nouns alone — correct for a caller with no loaded
 * vault, and never another vault's taxonomy.
 */
export function classifyIntent(query: string, vocabulary: readonly string[] = []): SearchIntent {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const domain = vocabulary.length === 0 ? LOCATION_NOUNS : `${LOCATION_NOUNS}|${vocabulary.map(escapeRegex).join("|")}`;

  // Location: where/which/what + a container or kind noun, or located/implemented/defined
  if (
    /(^|\b)(where|which|what)\b/u.test(normalized) &&
    new RegExp(
      `(\\b(${domain})\\b|\\blive\\b|\\blocated\\b|\\bimplemented\\b|\\bdefined\\b|\\bstored\\b|\\bkept\\b|\\bowned\\b)`,
      "u",
    ).test(normalized)
  ) {
    return "location";
  }

  // Temporal: "what changed", "recent changes", "history of changes", "what's new", "changelog"
  if (/\b(what changed|recent changes|history of changes|what's new|changelog)\b/u.test(normalized)) {
    return "temporal";
  }

  // Rationale: why, compare, comparison, tradeoff(s), decision(s), rationale, history, landscape
  if (/(^|\b)(why|compare|comparison|tradeoff|tradeoffs|decision|decisions|rationale|history|landscape)\b/u.test(normalized)) {
    return "rationale";
  }

  // Implementation: how does X work, show me the code, implementation of, what does X do, how is X implemented
  if (/\b(how does .+ work|show me the code|implementation of|what does .+ do|how is .+ implemented)\b/u.test(normalized)) {
    return "implementation";
  }

  return "general";
}
