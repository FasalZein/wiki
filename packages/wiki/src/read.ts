import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { Nodes } from "mdast";
import { parseNoteText } from "./frontmatter.ts";
import { parseMarkdown } from "./markdown.ts";
import { canonicalPathProblem } from "./paths.ts";
import { containedEntry, WikiError } from "./vault.ts";

function renderedLeafText(node: Nodes): string | undefined {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  return undefined;
}
function renderedText(node: Nodes): string {
  const leaf = renderedLeafText(node);
  if (leaf !== undefined) return leaf;
  if (node.type === "break") return "\n";
  return "children" in node ? node.children.map(renderedText).join("") : "";
}
function validateNotePath(relative: string): void {
  const invalid = canonicalPathProblem(relative);
  if (invalid) throw new WikiError("usage", invalid.message);
  if (!relative.endsWith(".md") || relative.split("/").some(p => [".wiki", ".git", ".obsidian", "node_modules", "assets"].includes(p)) || relative === "log.md") {
    throw new WikiError("usage", "Expected a canonical Markdown note path outside operational and capture directories");
  }
}
function captureNote(root: string, relative: string): { markdown: string; digest: string } {
  validateNotePath(relative);
  const { full, stat } = containedEntry(root, relative);
  if (!stat) throw new WikiError("not_found", "Missing requested note: " + relative);
  if (!stat.isFile()) throw new WikiError("usage", "Expected a regular Markdown note: " + relative);
  const bytes = fs.readFileSync(full);
  let markdown: string;
  try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new WikiError("damaged", "Note is not valid UTF-8: " + relative); }
  return { markdown, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}
function sectionBody(markdown: string, relative: string): string {
  try { return parseNoteText(markdown).body; }
  catch (error) { throw new WikiError("damaged", "Cannot select a section in " + relative + ": " + (error instanceof Error ? error.message : String(error))); }
}
function physicalLineStart(body: string, offset: number): number {
  // CommonMark source lines can end with LF, CRLF, or bare CR; EOF is not a line boundary to rewind.
  while (offset > 0 && body[offset - 1] !== "\n" && body[offset - 1] !== "\r") offset--;
  return offset;
}
function headingBounds(body: string, heading: Extract<Nodes, { type: "heading" }>, next: Extract<Nodes, { type: "heading" }> | undefined): [number, number] {
  // AST offsets are UTF-16 source offsets, so slice the unmodified body, not reconstructed Markdown.
  const start = heading.position?.start.offset;
  const end = next ? next.position?.start.offset : body.length;
  if (start === undefined || end === undefined) throw new Error("CommonMark heading has no source offset");
  // AST heading starts omit legal indentation. Include it only for the selected heading.
  return [physicalLineStart(body, start), next ? physicalLineStart(body, end) : end];
}
function selectSection(markdown: string, relative: string, section: string): string {
  const body = sectionBody(markdown, relative);
  // Document-level headings define sections; quoted/list-contained headings remain source content.
  const headings = parseMarkdown(body).children.filter(node => node.type === "heading");
  const matches = headings.filter(node => renderedText(node) === section);
  const heading = matches[0];
  if (!heading) throw new WikiError("not_found", "Missing requested section in " + relative + ": " + section);
  if (matches.length !== 1) throw new WikiError("usage", "Duplicate matching headings in " + relative + ": " + section);
  const next = headings.slice(headings.indexOf(heading) + 1).find(node => node.depth <= heading.depth);
  const [start, end] = headingBounds(body, heading, next);
  return body.slice(start, end);
}

/** Capture once: the digest names the same full bytes that supply the output. */
export function readNote(root: string, relative: string, section?: string) {
  const { markdown, digest } = captureNote(root, relative);
  if (section === undefined) return { path: relative, markdown, digest };
  return { path: relative, section, markdown: selectSection(markdown, relative, section), digest };
}
