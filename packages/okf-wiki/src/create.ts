import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { inspectVault } from "./lint.ts";
import { indexDestinationDiagnostics, markdownText } from "./navigation.ts";
import { loadRegistry, safeName, type Diagnostic } from "./registry.ts";
import { containedEntry, createExclusive, WikiError } from "./vault.ts";

export interface CreateRequest {
  type: string; scope: string; title: string; description: string;
  slug?: string; body?: string; tags?: string[]; status?: string;
}
export class CreateValidationError extends WikiError {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) { super("usage", "Proposed topic or vault validation failed"); this.diagnostics = diagnostics; }
}
export class CreatePartialError extends WikiError {
  readonly written = true;
  readonly paths: string[];
  readonly digest: string;
  constructor(paths: string[], digest: string) {
    super("damaged", "Topic published but navigation or log failed; run index to repair navigation and inspect log.md before adding any missing historical entry manually");
    this.paths = paths; this.digest = digest;
  }
}
/** Caller holds the cooperative mutation lock through validation and all publication effects. */
export function createTopic(root: string, request: CreateRequest) {
  const registry = loadRegistry(root);
  if (registry.diagnostics.length) throw new CreateValidationError(registry.diagnostics);
  const type = registry.types.find(t => t.record.name === request.type);
  if (!type) throw new WikiError("usage", "Unknown registered type: " + request.type);
  const slug = request.slug ?? request.title.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!safeName(slug)) throw new WikiError("usage", "Cannot derive a safe ASCII slug; supply --slug with a non-reserved lowercase hyphenated name");
  const relative = request.scope + "/" + type.record.folder + "/" + slug + ".md";
  const target = containedEntry(root, relative);
  if (target.stat) throw new WikiError("conflict", "Existing topic destination: " + relative);
  const body = request.body ?? type.record.template;
  // A body file cannot inject a second metadata block or select a template engine.
  if (/^\uFEFF?---(?:[A-Za-z][\w-]*)?[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.test(body)) throw new WikiError("usage", "Body file must contain Markdown body only, not leading frontmatter");
  const data = { type: request.type, title: request.title, description: request.description,
    created: new Date().toISOString(), ...(request.tags ? { tags: request.tags } : {}), ...(request.status !== undefined ? { status: request.status } : {}) };
  // JSON scalar/array syntax is safe YAML data, including punctuation and escaped control characters.
  const markdown = "---\n" + Object.entries(data).map(([key, value]) => key + ": " + JSON.stringify(value)).join("\n") + "\n---\n" + body;
  const inventory = inspectVault(root, undefined, { path: relative, markdown });
  if (inventory.diagnostics.some(d => d.path === relative && d.rule === "title.duplicate")) throw new WikiError("conflict", "Duplicate normalized title in " + request.scope);
  inventory.diagnostics.push(...indexDestinationDiagnostics(root, inventory.indexes.keys()));
  if (inventory.diagnostics.length) throw new CreateValidationError(inventory.diagnostics);
  const digest = "sha256:" + createHash("sha256").update(markdown).digest("hex");
  fs.mkdirSync(containedEntry(root, path.posix.dirname(relative)).full, { recursive: true });
  try { createExclusive(root, relative, markdown); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new WikiError("conflict", "Existing topic destination: " + relative);
    throw error;
  }
  try {
    for (const [file, bytes] of inventory.indexes) fs.writeFileSync(containedEntry(root, file).full, bytes);
    const log = containedEntry(root, "log.md").full;
    const previous = fs.readFileSync(log, "utf8");
    const heading = "## " + new Date().toISOString().slice(0, 10) + "\n\n";
    const entry = "**created** [" + markdownText(request.title) + "](" + relative + ")\n\n";
    fs.writeFileSync(log, heading + entry + (previous.startsWith(heading) ? previous.slice(heading.length) : previous));
  } catch { throw new CreatePartialError([relative], digest); }
  return { path: relative, title: request.title, description: request.description, digest };
}
