import { parseDocument } from "yaml";

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fixed delimiters cannot select an executable engine. No parse cache or timestamp coercion. */
export function parseNoteText(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Expected YAML mapping frontmatter with plain --- delimiters");
  const doc = parseDocument(match[1] ?? "", { schema: "core", customTags: [], uniqueKeys: true });
  // Unknown tags are warnings in yaml; they must fail closed, not silently lose their tag.
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new Error("Invalid YAML frontmatter: " + problem.message);
  const data: unknown = doc.toJS();
  if (!isMapping(data)) throw new Error("Frontmatter must be a YAML mapping");
  return { frontmatter: data, body: text.slice(match[0].length) };
}
