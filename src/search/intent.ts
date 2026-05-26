export type SearchIntent = "location" | "rationale" | "implementation" | "temporal" | "general";

/**
 * Classify the query's intent to determine the query strategy.
 *
 * Order matters: location and temporal are checked first as guards,
 * then rationale, then implementation, then default to general.
 */
export function classifyIntent(query: string): SearchIntent {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();

  // Location: where/which/what + file/doc/module/page/folder/route keywords, or located/implemented/defined
  if (
    /(^|\b)(where|which|what)\b/u.test(normalized) &&
    /(\b(file|files|doc|docs|page|pages|module|modules|spec|specs|prd|prds|slice|slices|task|tasks|folder|folders|route|routes)\b|\blive\b|\blocated\b|\bimplemented\b|\bdefined\b|\bstored\b|\bkept\b|\bowned\b)/u.test(
      normalized,
    )
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
