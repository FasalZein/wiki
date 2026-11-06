import * as fs from "node:fs";
import * as path from "node:path";
import { caseFold } from "unicode-case-folding";
import { parseNoteText } from "./frontmatter.ts";
import { metadataLines, missingHeadings, parseMarkdown } from "./markdown.ts";
import { declaresProperty, loadRegistry, safeName, schemaDiagnostics, sortDiagnostics, type Diagnostic } from "./registry.ts";

const SKIP = new Set([".wiki", ".git", ".obsidian", "node_modules"]);
function isCaptureAsset(relative: string): boolean {
  const parts = relative.split("/");
  return parts[0] === "personal" && parts[1] === "assets" || parts[0] === "projects" && safeName(parts[1] ?? "") && parts[2] === "assets";
}
function scopeOf(relative: string): string | undefined {
  const parts = relative.split("/");
  if (parts[0] === "personal") return "personal";
  if (parts[0] === "projects" && safeName(parts[1] ?? "")) return "projects/" + parts[1];
  return undefined;
}
export function lintVault(root: string, selected?: string): Diagnostic[] {
  const { types, diagnostics } = loadRegistry(root);
  const notes: { path: string; scope: string | undefined; data: Record<string, unknown>; canonical: boolean }[] = [];
  function fail(file: string, rule: string, message: string, fix: string) { diagnostics.push({ path: file, rule, message, fix }); }
  function visit(relative: string) {
    if (isCaptureAsset(relative)) return;
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) { fail(relative, "path.missing", "Missing requested path", "Select an existing note path"); return; }
    if (stat.isSymbolicLink()) { fail(relative, "path.symlink", "Symlinked note trees and files are refused", "Use regular vault-owned files and directories"); return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) if (!SKIP.has(name)) visit(relative ? relative + "/" + name : name);
      return;
    }
    if (!relative.endsWith(".md") || relative === "log.md") return;
    if (path.basename(relative) === "index.md") {
      const directory = path.posix.dirname(relative), scope = scopeOf(directory);
      const folder = scope && directory.startsWith(scope + "/") ? directory.slice(scope.length + 1) : undefined;
      const generated = relative === "index.md" || relative === "projects/index.md" || scope !== undefined && (directory === scope || types.some(t => t.record.folder === folder && (!t.record.scopes || t.record.scopes.includes(scope))));
      if (!generated) fail(relative, "path.layout", "Unexpected index outside a maintained directory", "Place generated indexes only at vault, scope, or registered-folder roots");
      return;
    }
    let parsed: ReturnType<typeof parseNoteText>;
    try { parsed = parseNoteText(fs.readFileSync(full, "utf8")); }
    catch (error) { fail(relative, "frontmatter.yaml", error instanceof Error ? error.message : String(error), "Use safe YAML mapping data with plain --- delimiters"); return; }
    const { frontmatter: data, body } = parsed;
    const type = types.find(t => t.record.name === data.type);
    if (!type) { fail(relative, "frontmatter.type", "Unknown or missing registered type: " + String(data.type), "Set type to a valid registry name or repair its registry record"); return; }
    if (!type.validate(data)) diagnostics.push(...schemaDiagnostics(relative, type.validate.errors));
    const tree = parseMarkdown(body);
    for (const message of missingHeadings(tree, type.record.requiredHeadings, type.record.name)) fail(relative, "body.heading", message, "Add the required authored heading at its registered level and context");
    for (const line of metadataLines(tree)) fail(relative, "body.metadata", "Repeated body metadata: " + line, "Keep status and type in frontmatter; quote or fence literal examples");
    // Custom fields remain flat even if a custom schema permits nested values.
    for (const [key, value] of Object.entries(data)) {
      if (!declaresProperty(type.record.frontmatterSchema, key)) fail(relative, "frontmatter.declared", "Undeclared frontmatter property: " + key, "Remove the property or declare its flat value contract in the type schema");
      const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
      if (!scalar(value) && !(Array.isArray(value) && value.every(item => typeof item === "string"))) fail(relative, "frontmatter.flat", "Nested frontmatter value: " + key, "Use flat scalar properties or lists of strings");
    }
    const segments = relative.split("/");
    const scope = scopeOf(relative);
    const offset = segments[0] === "personal" ? 1 : 2;
    const layout = scope !== undefined && segments.length === offset + 2 && segments[offset] === type.record.folder && safeName((segments[offset + 1] ?? "").slice(0, -3));
    notes.push({ path: relative, scope, data, canonical: layout && scope !== undefined && (!type.record.scopes || type.record.scopes.includes(scope)) });
    if (!layout) {
      fail(relative, "path.layout", "Expected scope/" + type.record.folder + "/<slug>.md", "Use personal or projects/<safe-project>, the registered folder, and one safe slug");
    }
    if (type.record.scopes && (!scope || !type.record.scopes.includes(scope))) fail(relative, "frontmatter.scope", "Type is not allowed in scope " + String(scope), "Use one of the exact registered scopes: " + type.record.scopes.join(", "));
  }
  if (selected !== undefined) {
    if (!selected || selected.includes("\\") || selected.includes("\0") || path.isAbsolute(selected) || isCaptureAsset(selected) || selected.split("/").some(p => !p || p === "." || p === ".." || SKIP.has(p))) {
      fail(selected, "path.invalid", "Expected a contained canonical note path", "Use a vault-relative path without dot segments or operational directories");
    } else {
      // Check every existing ancestor before entering the requested subtree.
      const parts = selected.split("/");
      let symlink = false;
      for (let i = 1; i < parts.length; i++) if (fs.lstatSync(path.join(root, ...parts.slice(0, i)), { throwIfNoEntry: false })?.isSymbolicLink()) symlink = true;
      if (symlink) fail(selected, "path.symlink", "Symlinked ancestor is refused", "Use a regular vault-owned note tree");
      else if (!fs.lstatSync(path.join(root, selected), { throwIfNoEntry: false })) fail(selected, "path.missing", "Missing requested path", "Select an existing note path");
    }
  }
  // Registry diagnostics are always applicable, even for an invalid selected path.
  if (selected !== undefined && diagnostics.some(d => d.path === selected && d.rule.startsWith("path."))) return sortDiagnostics(diagnostics);
  for (const name of fs.readdirSync(root).sort()) if (!SKIP.has(name)) visit(name);
  const topics = new Set(notes.filter(n => n.canonical).map(n => n.path));
  const titles = new Map<string, typeof notes>();
  for (const note of notes) {
    if (typeof note.data.superseded_by === "string" && !topics.has(note.data.superseded_by)) fail(note.path, "lifecycle.target", "superseded_by must name an existing canonical topic: " + note.data.superseded_by, "Use a vault-relative topic path with .md and no dot segments");
    if (!note.scope || typeof note.data.title !== "string") continue;
    const key = note.scope + "\0" + caseFold(note.data.title.trim());
    const group = titles.get(key) ?? [];
    group.push(note); titles.set(key, group);
  }
  for (const group of titles.values()) if (group.length > 1) for (const note of group) fail(note.path, "title.duplicate", "Duplicate title in " + note.scope + ": " + group.map(n => n.path).join(", "), "Choose distinct titles within this scope");
  const inSelection = (file: string) => selected === undefined || file === selected || file.startsWith(selected + "/");
  const scopes = new Set(notes.filter(n => inSelection(n.path)).map(n => n.scope));
  if (selected !== undefined) scopes.add(scopeOf(selected));
  return sortDiagnostics(diagnostics.filter(d => d.path.startsWith(".wiki/types/") || inSelection(d.path) || d.rule === "title.duplicate" && scopes.has(scopeOf(d.path))));
}
