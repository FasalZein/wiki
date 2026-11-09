import * as fs from "node:fs";
import { inspectContainedPath } from "./paths.ts";
import { parseNoteText } from "./frontmatter.ts";
import { parseMarkdown } from "./markdown.ts";
import { safeName, type Diagnostic } from "./registry.ts";
import { readRevisionAt, WikiError } from "./vault.ts";

// The scan step: read the vault once into an immutable inventory. It applies no registry rule; validation
// (lint.ts) and navigation rendering read the inventory. A pending change is the same inventory with one note
// added or replaced (withNote), never a mode of the scan.

export const SKIP: ReadonlySet<string> = new Set([".wiki", ".git", ".obsidian", "node_modules"]);
export function isCaptureAsset(relative: string): boolean {
  const parts = relative.split("/");
  return parts[0] === "personal" && parts[1] === "assets" || parts[0] === "projects" && safeName(parts[1] ?? "") && parts[2] === "assets";
}
export function scopeOf(relative: string): string | undefined {
  const parts = relative.split("/");
  if (parts[0] === "personal") return "personal";
  if (parts[0] === "projects" && safeName(parts[1] ?? "")) return "projects/" + parts[1];
  return undefined;
}

/** A note whose bytes decoded as UTF-8 and whose frontmatter parsed as safe YAML data. */
export interface ParsedNote {
  readonly path: string; readonly markdown: string; readonly data: Readonly<Record<string, unknown>>;
  readonly body: string; readonly tree: ReturnType<typeof parseMarkdown>;
}
/** One Markdown note path: its parsed content, or the problem that stopped reading or parsing it.
 * The problem belongs to the note, so a replacement note drops it with the old content. */
export type ScannedNote = { readonly path: string } & ({ readonly note: ParsedNote; readonly problem?: never } | { readonly note?: never; readonly problem: Diagnostic });
export interface PlannedAsset { readonly path: string; readonly bytes: Buffer }
/** A note that a create, replace or capture will publish. Capture also plans its retained asset bytes. */
export interface PendingNote { readonly path: string; readonly markdown: string; readonly assets?: readonly PlannedAsset[] }

export interface Inventory {
  readonly root: string;
  /** Every scanned directory ("" is the vault root), plus the parent directories of a pending note. */
  readonly directories: readonly string[];
  /** index.md files found in the tree. Their bytes are never read by the scan. */
  readonly indexFiles: readonly string[];
  /** Markdown notes in scan order; a pending note comes last. */
  readonly notes: readonly ScannedNote[];
  /** Path-level problems: refused paths, non-regular files and unreadable directories. */
  readonly problems: readonly Diagnostic[];
  /** The note added or replaced by withNote, with its planned retained assets. */
  readonly pending?: { readonly path: string; readonly assets: readonly PlannedAsset[] };
}

function problemAt(path: string, rule: string, message: string, fix: string): Diagnostic { return { path, rule, message, fix }; }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Parse note text; a YAML failure is the note's frontmatter.yaml problem. */
export function parseNote(relative: string, markdown: string): ScannedNote {
  let parsed: ReturnType<typeof parseNoteText>;
  try { parsed = parseNoteText(markdown); }
  catch (error) { return { path: relative, problem: problemAt(relative, "frontmatter.yaml", errorText(error), "Use safe YAML mapping data with plain --- delimiters") }; }
  return { path: relative, note: { path: relative, markdown, data: parsed.frontmatter, body: parsed.body, tree: parseMarkdown(parsed.body) } };
}

/** Read the whole vault. Each note's bytes are read once through the protected read and retained: later steps
 * never reread a validated path, because a noncooperating editor can replace it in between. */
export function scanVault(root: string): Inventory {
  const directories: string[] = [""], indexFiles: string[] = [], notes: ScannedNote[] = [], problems: Diagnostic[] = [];
  const unreadable = (relative: string, error: unknown) => problemAt(relative, "path.unreadable", errorText(error), "Restore readable regular vault-owned files and synchronize again");
  function visit(relative: string) {
    try { inspectEntry(relative); }
    catch (error) { problems.push(unreadable(relative, error)); }
  }
  function inspectEntry(relative: string) {
    if (isCaptureAsset(relative)) return;
    const inspected = inspectContainedPath(root, relative);
    if (!inspected.ok) { problems.push(problemAt(relative, inspected.problem.rule, inspected.problem.message, "Use a canonical path and regular vault-owned ancestors")); return; }
    const { full, stat } = inspected;
    if (!stat) { problems.push(problemAt(relative, "path.missing", "Missing requested path", "Select an existing note path")); return; }
    if (stat.isDirectory()) {
      directories.push(relative);
      for (const name of fs.readdirSync(full).sort()) if (!SKIP.has(name)) visit(relative ? relative + "/" + name : name);
      return;
    }
    if (!relative.endsWith(".md") || relative === "log.md") return;
    if (!stat.isFile()) { problems.push(problemAt(relative, "path.kind", "Expected a regular Markdown file", "Use a regular vault-owned Markdown file")); return; }
    if (relative === "index.md" || relative.endsWith("/index.md")) { indexFiles.push(relative); return; }
    notes.push(readNote(relative, full));
  }
  function readNote(relative: string, full: string): ScannedNote {
    let bytes: Buffer;
    try { bytes = readRevisionAt(full, () => new WikiError("usage", "Expected a regular Markdown note: " + relative)).bytes; }
    catch (error) { return { path: relative, problem: unreadable(relative, error) }; }
    let markdown: string;
    try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return { path: relative, problem: problemAt(relative, "document.utf8", "Note is not valid UTF-8", "Save the complete note as valid UTF-8 without replacing or discarding authored bytes") }; }
    return parseNote(relative, markdown);
  }
  try { for (const name of fs.readdirSync(root).sort().filter(name => !SKIP.has(name))) visit(name); }
  catch (error) { problems.push(problemAt("", "path.unreadable", errorText(error), "Restore readable vault directories and synchronize again")); }
  return { root, directories, indexFiles, notes, problems };
}

/** The inventory as it will be after note publishes: a note at the same path is replaced (one identity, no
 * old content or its problems), otherwise the note is added. Its parent directories join the directory list. */
export function withNote(inventory: Inventory, note: PendingNote): Inventory {
  const parents = note.path.split("/").slice(0, -1);
  const directories = [...inventory.directories];
  for (let i = 1; i <= parents.length; i++) {
    const directory = parents.slice(0, i).join("/");
    if (!directories.includes(directory)) directories.push(directory);
  }
  return { ...inventory, directories, notes: [...inventory.notes.filter(n => n.path !== note.path), parseNote(note.path, note.markdown)],
    pending: { path: note.path, assets: note.assets ?? [] } };
}
