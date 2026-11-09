import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { linkDiagnostics } from "./links.ts";
import { canonicalPathProblem, inspectContainedPath } from "./paths.ts";
import { parseNoteText } from "./frontmatter.ts";
import { metadataLines, missingHeadings, parseMarkdown } from "./markdown.ts";
import { declaresProperty, loadRegistry, safeName, schemaDiagnostics, sortDiagnostics, type Diagnostic, type Registry } from "./registry.ts";
import { readRevisionAt, WikiError } from "./vault.ts";
import { maintainedDirectory, renderIndexes, indexFreshnessDiagnostics, type NavigationDirectory, type NavigationTopic } from "./navigation.ts";

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
export interface ProspectiveAsset { path: string; bytes: Buffer }
export type ProspectiveNote = { path: string; markdown: string } & (
  { replace: true; assets?: never } | { replace?: never; assets?: readonly ProspectiveAsset[] }
);
interface InventoryNote {
  path: string; scope: string | undefined; data: Record<string, unknown>; canonical: boolean;
  markdown: string; body: string; tree: ReturnType<typeof parseMarkdown>;
}

function selectedPathDiagnostics(root: string, selected: string): Diagnostic[] {
  const invalid = canonicalPathProblem(selected);
  if (invalid || isCaptureAsset(selected) || selected.split("/").some(p => SKIP.has(p))) {
    return [{ path: selected, rule: "path.invalid", message: invalid?.message ?? "Expected a canonical note path outside operational and capture directories", fix: "Use a vault-relative path without dot segments or operational directories" }];
  }
  const inspected = inspectContainedPath(root, selected);
  if (!inspected.ok) return [{ path: selected, rule: inspected.problem.rule, message: inspected.problem.message, fix: "Use regular vault-owned note trees" }];
  if (!inspected.stat) return [{ path: selected, rule: "path.missing", message: "Missing requested path", fix: "Select an existing note path" }];
  return [];
}

function prospectiveDirectories(relative: string, types: Parameters<typeof maintainedDirectory>[1], directories: NavigationDirectory[], indexes: Set<string>): void {
  const parents = relative.split("/").slice(0, -1);
  for (let i = 1; i <= parents.length; i++) {
    const relative = parents.slice(0, i).join("/");
    const directory = maintainedDirectory(relative, types);
    if (directory && !directories.some(d => d.path === relative)) { directories.push(directory); indexes.add(relative + "/index.md"); }
  }
}

function retainedAssetProblem(root: string, value: string, planned: ReadonlyMap<string, Buffer>): string | undefined {
  const invalid = canonicalPathProblem(value);
  const inspected = invalid ? { ok: false as const, problem: invalid } : inspectContainedPath(root, value);
  if (!inspected.ok) return inspected.problem.message;
  if ((!inspected.stat?.isFile() && !planned.has(value)) || !isCaptureAsset(value)) return "Expected an existing retained asset at a canonical capture path: " + value;
  return undefined;
}

function sourceAssetDiagnostics(root: string, note: InventoryNote, field: string, planned: ReadonlyMap<string, Buffer>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const value = note.data[field];
  if (typeof value !== "string") return diagnostics; // The registered schema reports missing or non-string values.
  const problem = retainedAssetProblem(root, value, planned);
  const bytes = planned.get(value);
  if (bytes && note.data[field + "_sha256"] !== "sha256:" + createHash("sha256").update(bytes).digest("hex")) diagnostics.push({ path: note.path, rule: "source.digest", message: field + ": digest does not match planned retained bytes", fix: "Use the digest of the exact retained asset bytes" });
  if (problem !== undefined) diagnostics.push({ path: note.path, rule: "source.path", message: field + ": " + problem, fix: "Use a canonical vault-relative retained asset path without dot segments or symlinks" });
  return diagnostics;
}

function sourceDiagnostics(root: string, note: InventoryNote, planned: ReadonlyMap<string, Buffer>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (note.data.type !== "source") return diagnostics;
  for (const field of ["original", "extracted"]) {
    diagnostics.push(...sourceAssetDiagnostics(root, note, field, planned));
  }
  return diagnostics;
}

// Case folding loads on first use, so commands without a vault scan skip it.
const require = createRequire(import.meta.url);
let caseFold: typeof import("unicode-case-folding").caseFold | undefined;
function duplicateTitleDiagnostics(notes: InventoryNote[]): Diagnostic[] {
  caseFold ??= (require("unicode-case-folding") as typeof import("unicode-case-folding")).caseFold;
  const titles = new Map<string, InventoryNote[]>();
  for (const note of notes) {
    if (!note.scope || typeof note.data.title !== "string") continue;
    const key = note.scope + "\0" + caseFold(note.data.title.trim().normalize("NFC")).normalize("NFC");
    const group = titles.get(key) ?? [];
    group.push(note); titles.set(key, group);
  }
  return [...titles.values()].filter(group => group.length > 1).flatMap(group => group.map(note => ({
    path: note.path, rule: "title.duplicate", message: "Duplicate title in " + note.scope + ": " + group.map(n => n.path).join(", "), fix: "Choose distinct titles within this scope",
  })));
}

function lifecycleDiagnostics(note: InventoryNote, topics: ReadonlySet<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (typeof note.data.superseded_by === "string" && !topics.has(note.data.superseded_by)) diagnostics.push({ path: note.path, rule: "lifecycle.target", message: "superseded_by must name an existing canonical topic: " + note.data.superseded_by, fix: "Use a vault-relative topic path with .md and no dot segments" });
  return diagnostics;
}

function crossNoteDiagnostics(root: string, notes: InventoryNote[], indexes: Set<string>, selected: string | undefined, prospective: ProspectiveNote | undefined, assets: ReadonlyMap<string, Buffer>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const topics = new Set(notes.filter(n => n.canonical).map(n => n.path));
  const plannedTargets = new Set(indexes);
  if (prospective) plannedTargets.add(prospective.path);
  const noAssets = new Map<string, Buffer>();
  for (const note of notes) {
    // Whole-vault callers repair planned indexes or report freshness; selected lint requires existing link targets.
    const planned = note.path === prospective?.path ? assets : noAssets;
    const targets = planned.size ? new Set([...plannedTargets, ...planned.keys()]) : plannedTargets;
    diagnostics.push(...linkDiagnostics(root, note.path, note.body, note.tree, relative => topics.has(relative) || indexes.has(relative) || isCaptureAsset(relative), selected === undefined ? targets : undefined));
    diagnostics.push(...sourceDiagnostics(root, note, planned));
    diagnostics.push(...lifecycleDiagnostics(note, topics));
  }
  return [...diagnostics, ...duplicateTitleDiagnostics(notes)];
}

function navigationTopics(notes: InventoryNote[]): NavigationTopic[] {
  const navigation: NavigationTopic[] = [];
  for (const note of notes) {
    const { type, title, description } = note.data;
    if (note.canonical && typeof type === "string" && typeof title === "string" && typeof description === "string") navigation.push({ path: note.path, type, title, description });
  }
  return navigation;
}

function selectedDiagnostics(notes: InventoryNote[], diagnostics: Diagnostic[], selected?: string): Diagnostic[] {
  const inSelection = (file: string) => selected === undefined || file === selected || file.startsWith(selected + "/");
  const scopes = new Set(notes.filter(n => inSelection(n.path)).map(n => n.scope));
  if (selected !== undefined) scopes.add(scopeOf(selected));
  return sortDiagnostics(diagnostics.filter(d => d.path.startsWith(".wiki/types/") || inSelection(d.path) || d.rule === "title.duplicate" && scopes.has(scopeOf(d.path))));
}
function isScopeOwnedAsset(relative: string, scope: string | undefined): boolean {
  return isCaptureAsset(relative) && !!scope && relative.startsWith(scope + "/assets/");
}

function plannedAssetProblem(root: string, relative: string, scope: string | undefined, assets: ReadonlyMap<string, Buffer>): string | undefined {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) return inspected.problem.message;
  if (inspected.stat || !isScopeOwnedAsset(relative, scope) || assets.has(relative)) return "Expected a unique new canonical retained asset in the candidate scope";
  return undefined;
}

function planCaptureAssets(root: string, prospective: ProspectiveNote | undefined, diagnostics: Diagnostic[]): Map<string, Buffer> {
  const assets = new Map<string, Buffer>();
  const scope = scopeOf(prospective?.path ?? "");
  for (const asset of prospective?.assets ?? []) {
    const problem = plannedAssetProblem(root, asset.path, scope, assets);
    if (problem !== undefined) diagnostics.push({ path: asset.path, rule: "source.asset", message: problem, fix: "Plan distinct scope-owned asset paths without existing targets or unsafe ancestors" });
    else assets.set(asset.path, asset.bytes);
  }
  return assets;
}

/** A caller that already loaded the registry in this command passes it to avoid a second load. */
export function inspectVault(root: string, selected?: string, prospective?: ProspectiveNote, registry: Registry = loadRegistry(root)) {
  const types = registry.types, diagnostics = [...registry.diagnostics];
  const registryValid = diagnostics.length === 0;
  const notes: InventoryNote[] = [];
  const assets = planCaptureAssets(root, prospective, diagnostics);
  const directories: NavigationDirectory[] = [{ path: "", type: "" }];
  const indexes = new Set<string>(["index.md"]);
  function fail(file: string, rule: string, message: string, fix: string) { diagnostics.push({ path: file, rule, message, fix }); }
  function visit(relative: string) {
    try { inspectEntry(relative); }
    catch (error) { fail(relative, "path.unreadable", error instanceof Error ? error.message : String(error), "Restore readable regular vault-owned files and synchronize again"); }
  }
  function inspectEntry(relative: string) {
    if (isCaptureAsset(relative)) return;
    const inspected = inspectContainedPath(root, relative);
    if (!inspected.ok) { fail(relative, inspected.problem.rule, inspected.problem.message, "Use a canonical path and regular vault-owned ancestors"); return; }
    const { full, stat } = inspected;
    if (!stat) { fail(relative, "path.missing", "Missing requested path", "Select an existing note path"); return; }
    if (stat.isDirectory()) {
      const directory = maintainedDirectory(relative, types);
      if (directory) { directories.push(directory); indexes.add(relative + "/index.md"); }
      for (const name of fs.readdirSync(full).sort()) if (!SKIP.has(name)) visit(relative ? relative + "/" + name : name);
      return;
    }
    if (!relative.endsWith(".md") || relative === "log.md") return;
    if (!stat.isFile()) { fail(relative, "path.kind", "Expected a regular Markdown file", "Use a regular vault-owned Markdown file"); return; }
    if (path.basename(relative) === "index.md") {
      const directory = path.posix.dirname(relative);
      const generated = maintainedDirectory(directory === "." ? "" : directory, types) !== undefined;
      if (generated) indexes.add(relative);
      if (!generated) fail(relative, "path.layout", "Unexpected index outside a maintained directory", "Place generated indexes only at vault, scope, or registered-folder roots");
      return;
    }
    // A replacement is one identity: do not retain old content or its diagnostics.
    if (prospective?.replace && relative === prospective.path) return;
    const { bytes } = readRevisionAt(full, () => new WikiError("usage", "Expected a regular Markdown note: " + relative));
    let markdown: string;
    try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch {
      fail(relative, "document.utf8", "Note is not valid UTF-8", "Save the complete note as valid UTF-8 without replacing or discarding authored bytes");
      return;
    }
    inspectNote(relative, markdown);
  }
  function inspectNote(relative: string, markdown: string) {
    let parsed: ReturnType<typeof parseNoteText>;
    try { parsed = parseNoteText(markdown); }
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
    notes.push({ path: relative, scope, data, markdown, body, tree, canonical: layout && scope !== undefined && (!type.record.scopes || type.record.scopes.includes(scope)) });
    if (!layout) {
      fail(relative, "path.layout", "Expected scope/" + type.record.folder + "/<slug>.md", "Use personal or projects/<safe-project>, the registered folder, and one safe slug");
    }
    if (type.record.scopes && (!scope || !type.record.scopes.includes(scope))) fail(relative, "frontmatter.scope", "Type is not allowed in scope " + String(scope), "Use one of the exact registered scopes: " + type.record.scopes.join(", "));
  }
  if (selected !== undefined) {
    const selectionProblems = selectedPathDiagnostics(root, selected);
    diagnostics.push(...selectionProblems);
    // Registry diagnostics are always applicable, even for an invalid selected path.
    if (selectionProblems.length) return { diagnostics: sortDiagnostics(diagnostics), indexes: new Map<string, string>(), concepts: [] };
  }
  try { for (const name of fs.readdirSync(root).sort().filter(name => !SKIP.has(name))) visit(name); }
  catch (error) { fail("", "path.unreadable", error instanceof Error ? error.message : String(error), "Restore readable vault directories and synchronize again"); }
  if (prospective) {
    prospectiveDirectories(prospective.path, types, directories, indexes);
    inspectNote(prospective.path, prospective.markdown);
  }
  diagnostics.push(...crossNoteDiagnostics(root, notes, indexes, selected, prospective, assets));
  // Retain the exact bytes decoded and validated above. Never reread a validated path
  // for indexing: a noncooperating editor can replace it between those operations.
  // A diagnostic on the vault root (""), on the note, or on any ancestor directory excludes the note.
  const diagnosed = new Set(diagnostics.map(d => d.path));
  const touched = (file: string) => {
    if (diagnosed.has("") || diagnosed.has(file)) return true;
    for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) if (diagnosed.has(file.slice(0, slash))) return true;
    return false;
  };
  const concepts = notes.filter(note => registryValid && note.canonical && !touched(note.path))
    .map(({ path, markdown }) => ({ path, markdown }));
  return { indexes: diagnostics.length ? new Map<string, string>() : renderIndexes(directories, navigationTopics(notes)),
    concepts, diagnostics: selectedDiagnostics(notes, diagnostics, selected) };
}

export function lintVault(root: string, selected?: string): Diagnostic[] {
  const inventory = inspectVault(root, selected);
  return sortDiagnostics([...inventory.diagnostics, ...(selected === undefined && !inventory.diagnostics.length ? indexFreshnessDiagnostics(root, inventory.indexes) : [])]);
}
