/**
 * Normalize query text for semantic search:
 * - Collapse newlines to spaces
 * - Strip unary negation syntax (leading - before words/quotes)
 * - Replace hyphens/underscores between word characters with spaces
 * - Collapse whitespace
 */
export function normalizeForSemantic(query: string): string {
  return query
    .replace(/\r?\n+/g, " ")
    .replace(/(^|\s)-(?=(?:\p{L}|\p{N}|"))/gu, "$1")
    .replace(/(?<=\p{L}|\p{N})[-_/]+(?=\p{L}|\p{N})/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
