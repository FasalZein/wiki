import * as path from "node:path";
import type { Nodes, Root } from "mdast";
import { visitAuthored } from "./markdown.ts";
import { inspectContainedPath } from "./paths.ts";
import type { Diagnostic } from "./registry.ts";

export function linkDiagnostics(root: string, file: string, body: string, tree: Root, allowed: (relative: string) => boolean): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fail = (rule: string, message: string) => diagnostics.push({ path: file, rule, message, fix: "Use standard document-relative Markdown links to existing vault notes, generated indexes, or retained assets; remove unsafe syntax" });
  const definitions = new Map<string, string>();
  // CommonMark definitions are document-wide, even when declared in a blockquote.
  // Only references in authored structure trigger checks of their destinations.
  function collectDefinitions(node: Nodes) {
    if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    if ("children" in node) for (const child of node.children) collectDefinitions(child);
  }
  collectDefinitions(tree);
  function check(url: string) {
    // Fragments are opaque. Decode only the target, never its heading/block text.
    const rawTarget = url.split(/[?#]/, 1)[0] ?? "";
    let decoded: string;
    try { decoded = decodeURIComponent(rawTarget); }
    catch { fail("link.invalid", "Malformed percent encoding in destination: " + url); return; }
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded)?.[1]?.toLowerCase();
    if (scheme) {
      if (!["http", "https", "mailto"].includes(scheme)) { fail("link.scheme", "Unsupported link scheme: " + url); return; }
      try {
        const external = new URL(decoded);
        if ((scheme === "http" || scheme === "https") && !external.hostname || scheme === "mailto" && !external.pathname) throw new Error("Missing address");
      } catch { fail("link.invalid", "Malformed external destination: " + url); }
      return; // Syntax only. Never fetch external destinations.
    }
    // Split before decoding, so encoded # and ? remain part of the target filename.
    const target = decoded;
    if (target.startsWith("/") || path.win32.isAbsolute(target) || /[\\\0]/.test(target)) {
      fail("link.unsafe", "Absolute, backslash, or NUL destination is refused: " + url); return;
    }
    const relative = target ? path.posix.normalize(path.posix.join(path.posix.dirname(file), target)) : file;
    if (relative === ".." || relative.startsWith("../")) { fail("link.unsafe", "Destination escapes the vault: " + url); return; }
    const inspected = inspectContainedPath(root, relative);
    if (!inspected.ok) { fail(inspected.problem.rule === "path.symlink" ? "link.symlink" : "link.unsafe", inspected.problem.message + " (" + url + ")"); return; }
    if (!inspected.stat) { fail("link.missing", "Missing local target: " + url + " (resolved " + relative + ")"); return; }
    if (!inspected.stat.isFile() || !allowed(relative)) fail("link.target", "Target is not a note, generated index, or retained asset: " + url);
  }
  visitAuthored(tree, node => {
    if (node.type === "link" || node.type === "image") check(node.url);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const url = definitions.get(node.identifier);
      if (url !== undefined) check(url);
    }
    if (node.type !== "paragraph" && node.type !== "heading") return;
    // Preserve raw escapes and formatting, but never join across literal/code/link spans.
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const base = start;
    let raw = body.slice(base, end);
    function mask(child: Nodes) {
      if (["inlineCode", "html", "link", "image", "linkReference", "imageReference"].includes(child.type)) {
        const from = child.position?.start.offset, to = child.position?.end.offset;
        if (from !== undefined && to !== undefined) raw = raw.slice(0, from - base) + "\n".repeat(to - from) + raw.slice(to - base);
        return;
      }
      if ("children" in child) for (const nested of child.children) mask(nested);
    }
    for (const child of node.children) mask(child);
    for (const match of raw.matchAll(/\[\[[^\]\r\n]+\]\]/g)) {
      const offset = match.index;
      let escapes = 0;
      for (let i = offset - 1; i >= 0 && raw[i] === "\\"; i--) escapes++;
      if (escapes % 2 === 0) fail("link.wikilink", "Wikilink syntax is not supported: " + match[0]);
    }
  });
  return diagnostics;
}
