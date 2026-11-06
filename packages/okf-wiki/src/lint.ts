import * as fs from "node:fs";
import * as path from "node:path";
import { parseNoteText } from "./frontmatter.ts";
import { declaresProperty, loadRegistry, schemaDiagnostics, sortDiagnostics, type Diagnostic } from "./registry.ts";

const SKIP = new Set([".wiki", ".git", ".obsidian", "node_modules", "assets"]);
export function lintVault(root: string, selected?: string): Diagnostic[] {
  const { types, diagnostics } = loadRegistry(root);
  function fail(file: string, rule: string, message: string, fix: string) { diagnostics.push({ path: file, rule, message, fix }); }
  function visit(relative: string) {
    const full = path.join(root, relative);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) { fail(relative, "path.missing", "Missing requested path", "Select an existing note path"); return; }
    if (stat.isSymbolicLink()) { fail(relative, "path.symlink", "Symlinked note trees and files are refused", "Use regular vault-owned files and directories"); return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) if (!SKIP.has(name)) visit(relative ? relative + "/" + name : name);
      return;
    }
    if (!relative.endsWith(".md") || path.basename(relative) === "index.md" || relative === "log.md") return;
    let data: Record<string, unknown>;
    try { data = parseNoteText(fs.readFileSync(full, "utf8")).frontmatter; }
    catch (error) { fail(relative, "frontmatter.yaml", error instanceof Error ? error.message : String(error), "Use safe YAML mapping data with plain --- delimiters"); return; }
    const type = types.find(t => t.record.name === data.type);
    if (!type) { fail(relative, "frontmatter.type", "Unknown or missing registered type: " + String(data.type), "Set type to a valid registry name or repair its registry record"); return; }
    if (!type.validate(data)) diagnostics.push(...schemaDiagnostics(relative, type.validate.errors));
    // Custom fields remain flat even if a custom schema permits nested values.
    for (const [key, value] of Object.entries(data)) {
      if (!declaresProperty(type.record.frontmatterSchema, key)) fail(relative, "frontmatter.declared", "Undeclared frontmatter property: " + key, "Remove the property or declare its flat value contract in the type schema");
      const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
      if (!scalar(value) && !(Array.isArray(value) && value.every(item => typeof item === "string"))) fail(relative, "frontmatter.flat", "Nested frontmatter value: " + key, "Use flat scalar properties or lists of strings");
    }
    const segments = relative.split("/");
    const scope = segments[0] === "personal" ? "personal" : segments[0] === "projects" && segments[1] ? "projects/" + segments[1] : undefined;
    if (type.record.scopes && (!scope || !type.record.scopes.includes(scope))) fail(relative, "frontmatter.scope", "Type is not allowed in scope " + String(scope), "Use one of the exact registered scopes: " + type.record.scopes.join(", "));
  }
  if (selected !== undefined) {
    if (!selected || selected.includes("\\") || selected.includes("\0") || path.isAbsolute(selected) || selected.split("/").some(p => !p || p === "." || p === ".." || SKIP.has(p))) {
      fail(selected, "path.invalid", "Expected a contained canonical note path", "Use a vault-relative path without dot segments or operational directories");
    } else {
      // Check every existing ancestor before entering the requested subtree.
      const parts = selected.split("/");
      let symlink = false;
      for (let i = 1; i < parts.length; i++) if (fs.lstatSync(path.join(root, ...parts.slice(0, i)), { throwIfNoEntry: false })?.isSymbolicLink()) symlink = true;
      if (symlink) fail(selected, "path.symlink", "Symlinked ancestor is refused", "Use a regular vault-owned note tree");
      else visit(selected);
    }
  } else {
    for (const name of fs.readdirSync(root).sort()) if (!SKIP.has(name)) visit(name);
  }
  return sortDiagnostics(diagnostics);
}
