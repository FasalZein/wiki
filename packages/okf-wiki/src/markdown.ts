import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";

/** CommonMark AST, with source positions retained for later link and section readers. */
export function parseMarkdown(body: string): Root { return fromMarkdown(body); }

/** Authored structure excludes literal examples and quoted/captured source material. */
export function visitAuthored(node: Nodes, visit: (node: Nodes) => void): void {
  if (["blockquote", "code", "inlineCode", "html"].includes(node.type)) return;
  visit(node);
  if ("children" in node) for (const child of node.children) visitAuthored(child, visit);
}
function authoredText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "break") return "\n";
  // A code span must not turn into an authored heading or metadata label.
  if (node.type === "inlineCode" || node.type === "html") return "\uFFFC";
  return "children" in node ? node.children.map(authoredText).join("") : "";
}
export function missingHeadings(tree: Root, required: { level: number; text: string }[], type: string): string[] {
  const headings: { level: number; text: string; parent?: { level: number; text: string } }[] = [];
  const stack: { level: number; text: string }[] = [];
  visitAuthored(tree, node => {
    if (node.type !== "heading") return;
    while (stack.length && (stack.at(-1)?.level ?? 0) >= node.depth) stack.pop();
    const text = authoredText(node);
    headings.push({ level: node.depth, text, parent: stack.at(-1) });
    stack.push({ level: node.depth, text });
  });
  return required.filter(wanted => !headings.some(found => found.level === wanted.level && found.text === wanted.text &&
    (type !== "decision" || wanted.text !== "Consequences" || found.level === 3 && found.parent?.level === 2 && found.parent.text === "Decision Outcome")))
    .map(h => "Missing authored level-" + h.level + " heading: " + h.text + (type === "decision" && h.text === "Consequences" ? " under Decision Outcome" : ""));
}
export function metadataLines(tree: Root): string[] {
  const lines: string[] = [];
  visitAuthored(tree, node => {
    if (node.type === "paragraph") for (const line of authoredText(node).split(/\r?\n/)) {
      if (/^\s*(?:Status|Type):(?:\s.*)?\s*$/.test(line)) lines.push(line.trim());
    }
  });
  return lines;
}
