import { createRequire } from "node:module";
import { linkDiagnostics } from "./links.ts";
import { canonicalPathProblem, inspectContainedPath } from "./paths.ts";
import { metadataLines, missingHeadings } from "./markdown.ts";
import { declaresProperty, loadRegistry, safeName, schemaDiagnostics, sortDiagnostics, type Diagnostic, type Registry } from "./registry.ts";
import { sha256, type Vault } from "./vault.ts";
import { maintainedDirectory, renderIndexes, indexFreshnessDiagnostics, type NavigationDirectory, type NavigationTopic } from "./navigation.ts";
import { isCaptureAsset, scanVault, scopeOf, SKIP, type Inventory, type ParsedNote } from "./inventory.ts";

// The validation step: the rules run over a scanned inventory and a compiled registry.

/** A note with a registered type. canonical: registered folder and scope, one safe slug. */
export interface CheckedNote extends ParsedNote { readonly scope: string | undefined; readonly canonical: boolean }
/** An inventory after validation. diagnostics: every rule result over the whole vault, sorted. */
export interface ValidatedInventory {
  readonly inventory: Inventory;
  readonly registry: Registry;
  readonly notes: readonly CheckedNote[];
  readonly directories: readonly NavigationDirectory[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface ValidateOptions {
  /** Selected-path lint requires link targets that exist now. Whole-vault validation also accepts generated
   * indexes and the pending note, because publication or index writes them. */
  existingLinkTargets?: boolean;
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

function retainedAssetProblem(root: string, value: string, planned: ReadonlyMap<string, Buffer>): string | undefined {
  const invalid = canonicalPathProblem(value);
  const inspected = invalid ? { ok: false as const, problem: invalid } : inspectContainedPath(root, value);
  if (!inspected.ok) return inspected.problem.message;
  if ((!inspected.stat?.isFile() && !planned.has(value)) || !isCaptureAsset(value)) return "Expected an existing retained asset at a canonical capture path: " + value;
  return undefined;
}

function sourceAssetDiagnostics(root: string, note: CheckedNote, field: string, planned: ReadonlyMap<string, Buffer>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const value = note.data[field];
  if (typeof value !== "string") return diagnostics; // The registered schema reports missing or non-string values.
  const problem = retainedAssetProblem(root, value, planned);
  const bytes = planned.get(value);
  if (bytes && note.data[field + "_sha256"] !== sha256(bytes)) diagnostics.push({ path: note.path, rule: "source.digest", message: field + ": digest does not match planned retained bytes", fix: "Use the digest of the exact retained asset bytes" });
  if (problem !== undefined) diagnostics.push({ path: note.path, rule: "source.path", message: field + ": " + problem, fix: "Use a canonical vault-relative retained asset path without dot segments or symlinks" });
  return diagnostics;
}

function sourceDiagnostics(root: string, note: CheckedNote, planned: ReadonlyMap<string, Buffer>): Diagnostic[] {
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
function duplicateTitleDiagnostics(notes: readonly CheckedNote[]): Diagnostic[] {
  caseFold ??= (require("unicode-case-folding") as typeof import("unicode-case-folding")).caseFold;
  const titles = new Map<string, CheckedNote[]>();
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

function lifecycleDiagnostics(note: CheckedNote, topics: ReadonlySet<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (typeof note.data.superseded_by === "string" && !topics.has(note.data.superseded_by)) diagnostics.push({ path: note.path, rule: "lifecycle.target", message: "superseded_by must name an existing canonical topic: " + note.data.superseded_by, fix: "Use a vault-relative topic path with .md and no dot segments" });
  return diagnostics;
}

function crossNoteDiagnostics(inventory: Inventory, notes: readonly CheckedNote[], indexes: ReadonlySet<string>, assets: ReadonlyMap<string, Buffer>, options: ValidateOptions): Diagnostic[] {
  const { root, pending } = inventory;
  const diagnostics: Diagnostic[] = [];
  const topics = new Set(notes.filter(n => n.canonical).map(n => n.path));
  const plannedTargets = new Set(indexes);
  if (pending) plannedTargets.add(pending.path);
  const noAssets = new Map<string, Buffer>();
  for (const note of notes) {
    const planned = note.path === pending?.path ? assets : noAssets;
    const targets = planned.size ? new Set([...plannedTargets, ...planned.keys()]) : plannedTargets;
    diagnostics.push(...linkDiagnostics(root, note.path, note.body, note.tree, relative => topics.has(relative) || indexes.has(relative) || isCaptureAsset(relative), options.existingLinkTargets ? undefined : targets));
    diagnostics.push(...sourceDiagnostics(root, note, planned));
    diagnostics.push(...lifecycleDiagnostics(note, topics));
  }
  return [...diagnostics, ...duplicateTitleDiagnostics(notes)];
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
function planCaptureAssets(inventory: Inventory, diagnostics: Diagnostic[]): Map<string, Buffer> {
  const assets = new Map<string, Buffer>();
  const scope = scopeOf(inventory.pending?.path ?? "");
  for (const asset of inventory.pending?.assets ?? []) {
    const problem = plannedAssetProblem(inventory.root, asset.path, scope, assets);
    if (problem !== undefined) diagnostics.push({ path: asset.path, rule: "source.asset", message: problem, fix: "Plan distinct scope-owned asset paths without existing targets or unsafe ancestors" });
    else assets.set(asset.path, asset.bytes);
  }
  return assets;
}

/** The per-note rules: registered type, schema, headings, body metadata, flat declared fields, layout and scope. */
function checkNote(note: ParsedNote, types: Registry["types"], diagnostics: Diagnostic[]): CheckedNote | undefined {
  const relative = note.path, data = note.data;
  const fail = (rule: string, message: string, fix: string) => diagnostics.push({ path: relative, rule, message, fix });
  const type = types.find(t => t.record.name === data.type);
  if (!type) { fail("frontmatter.type", "Unknown or missing registered type: " + String(data.type), "Set type to a valid registry name or repair its registry record"); return undefined; }
  if (!type.validate(data)) diagnostics.push(...schemaDiagnostics(relative, type.validate.errors));
  for (const message of missingHeadings(note.tree, type.record.requiredHeadings, type.record.name)) fail("body.heading", message, "Add the required authored heading at its registered level and context");
  for (const line of metadataLines(note.tree)) fail("body.metadata", "Repeated body metadata: " + line, "Keep status and type in frontmatter; quote or fence literal examples");
  // Custom fields remain flat even if a custom schema permits nested values.
  for (const [key, value] of Object.entries(data)) {
    if (!declaresProperty(type.record.frontmatterSchema, key)) fail("frontmatter.declared", "Undeclared frontmatter property: " + key, "Remove the property or declare its flat value contract in the type schema");
    const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
    if (!scalar(value) && !(Array.isArray(value) && value.every(item => typeof item === "string"))) fail("frontmatter.flat", "Nested frontmatter value: " + key, "Use flat scalar properties or lists of strings");
  }
  const segments = relative.split("/");
  const scope = scopeOf(relative);
  const offset = segments[0] === "personal" ? 1 : 2;
  const layout = scope !== undefined && segments.length === offset + 2 && segments[offset] === type.record.folder && safeName((segments[offset + 1] ?? "").slice(0, -3));
  const checked = { ...note, scope, canonical: layout && scope !== undefined && (!type.record.scopes || type.record.scopes.includes(scope)) };
  if (!layout) fail("path.layout", "Expected scope/" + type.record.folder + "/<slug>.md", "Use personal or projects/<safe-project>, the registered folder, and one safe slug");
  if (type.record.scopes && (!scope || !type.record.scopes.includes(scope))) fail("frontmatter.scope", "Type is not allowed in scope " + String(scope), "Use one of the exact registered scopes: " + type.record.scopes.join(", "));
  return checked;
}

/** Run every rule over an inventory and a compiled registry. */
export function validateInventory(inventory: Inventory, registry: Registry, options: ValidateOptions = {}): ValidatedInventory {
  const types = registry.types, diagnostics = [...registry.diagnostics];
  const assets = planCaptureAssets(inventory, diagnostics);
  diagnostics.push(...inventory.problems);
  const directories: NavigationDirectory[] = [];
  for (const relative of inventory.directories) {
    const directory = maintainedDirectory(relative, types);
    if (directory) directories.push(directory);
  }
  const indexes = new Set(directories.map(d => d.path ? d.path + "/index.md" : "index.md"));
  for (const relative of inventory.indexFiles) {
    if (!indexes.has(relative)) diagnostics.push({ path: relative, rule: "path.layout", message: "Unexpected index outside a maintained directory", fix: "Place generated indexes only at vault, scope, or registered-folder roots" });
  }
  const notes: CheckedNote[] = [];
  for (const scanned of inventory.notes) {
    if (scanned.problem) { diagnostics.push(scanned.problem); continue; }
    const checked = checkNote(scanned.note, types, diagnostics);
    if (checked) notes.push(checked);
  }
  diagnostics.push(...crossNoteDiagnostics(inventory, notes, indexes, assets, options));
  return { inventory, registry, notes, directories, diagnostics: sortDiagnostics(diagnostics) };
}

/** Scan and validate the current vault. A caller that already compiled the registry passes it. */
export function checkVault(root: string, registry: Registry = loadRegistry(root)): ValidatedInventory {
  return validateInventory(scanVault(root), registry);
}

/** Valid search concepts: with a valid registry, every canonical note with no diagnostic on the vault root (""),
 * on the note, or on any ancestor directory. Its bytes are the ones validated, never reread. */
export function searchConcepts(validated: ValidatedInventory): { path: string; markdown: string }[] {
  if (validated.registry.diagnostics.length) return [];
  const diagnosed = new Set(validated.diagnostics.map(d => d.path));
  const touched = (file: string) => {
    if (diagnosed.has("") || diagnosed.has(file)) return true;
    for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) if (diagnosed.has(file.slice(0, slash))) return true;
    return false;
  };
  return validated.notes.filter(note => note.canonical && !touched(note.path)).map(({ path, markdown }) => ({ path, markdown }));
}

/** The navigation step: generated index bytes for a clean validated inventory. Any diagnostic anywhere blocks
 * all planned navigation (an empty map), so no caller renders a partial index. */
export function navigationIndexes(validated: ValidatedInventory): Map<string, string> {
  if (validated.diagnostics.length) return new Map();
  const topics: NavigationTopic[] = [];
  for (const note of validated.notes) {
    const { type, title, description } = note.data;
    if (note.canonical && typeof type === "string" && typeof title === "string" && typeof description === "string") topics.push({ path: note.path, type, title, description });
  }
  return renderIndexes([...validated.directories], topics);
}

/** The diagnostics a selected-path lint reports: the selection, registry records, and scoped-title conflicts
 * that involve the selection's scopes. */
export function selectedDiagnostics(validated: ValidatedInventory, selected: string): Diagnostic[] {
  const inSelection = (file: string) => file === selected || file.startsWith(selected + "/");
  const scopes = new Set(validated.notes.filter(n => inSelection(n.path)).map(n => n.scope));
  scopes.add(scopeOf(selected));
  return validated.diagnostics.filter(d => d.path.startsWith(".wiki/types/") || inSelection(d.path) || d.rule === "title.duplicate" && scopes.has(scopeOf(d.path)));
}

export function lintVault(vault: Vault, selected?: string): Diagnostic[] {
  const registry = loadRegistry(vault.root);
  if (selected !== undefined) {
    const selectionProblems = selectedPathDiagnostics(vault.root, selected);
    // Registry diagnostics are always applicable, even for an invalid selected path.
    if (selectionProblems.length) return sortDiagnostics([...registry.diagnostics, ...selectionProblems]);
    return selectedDiagnostics(validateInventory(scanVault(vault.root), registry, { existingLinkTargets: true }), selected);
  }
  const validated = validateInventory(scanVault(vault.root), registry);
  return sortDiagnostics([...validated.diagnostics, ...(validated.diagnostics.length ? [] : indexFreshnessDiagnostics(vault.root, navigationIndexes(validated)))]);
}
