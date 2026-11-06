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
function registeredCreateType(root: string, name: string) {
  const registry = loadRegistry(root);
  if (registry.diagnostics.length) throw new CreateValidationError(registry.diagnostics);
  const type = registry.types.find(t => t.record.name === name);
  if (!type) throw new WikiError("usage", "Unknown registered type: " + name);
  return type;
}
function topicDestination(root: string, request: CreateRequest, folder: string): string {
  const slug = request.slug ?? request.title.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!safeName(slug)) throw new WikiError("usage", "Cannot derive a safe ASCII slug; supply --slug with a non-reserved lowercase hyphenated name");
  const relative = request.scope + "/" + folder + "/" + slug + ".md";
  const target = containedEntry(root, relative);
  if (target.stat) throw new WikiError("conflict", "Existing topic destination: " + relative);
  return relative;
}
function topicMarkdown(request: CreateRequest, template: string): string {
  const body = request.body ?? template;
  // A body file cannot inject a second metadata block or select a template engine.
  if (/^\uFEFF?---(?:[A-Za-z][\w-]*)?[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.test(body)) throw new WikiError("usage", "Body file must contain Markdown body only, not leading frontmatter");
  const data = { type: request.type, title: request.title, description: request.description,
    created: new Date().toISOString(), ...(request.tags ? { tags: request.tags } : {}), ...(request.status !== undefined ? { status: request.status } : {}) };
  // JSON scalar/array syntax is safe YAML data, including punctuation and escaped control characters.
  return "---\n" + Object.entries(data).map(([key, value]) => key + ": " + JSON.stringify(value)).join("\n") + "\n---\n" + body;
}
function prospectiveIndexes(root: string, relative: string, markdown: string, scope: string): Map<string, string> {
  const inventory = inspectVault(root, undefined, { path: relative, markdown });
  if (inventory.diagnostics.some(d => d.path === relative && d.rule === "title.duplicate")) throw new WikiError("conflict", "Duplicate normalized title in " + scope);
  inventory.diagnostics.push(...indexDestinationDiagnostics(root, inventory.indexes.keys()));
  if (inventory.diagnostics.length) throw new CreateValidationError(inventory.diagnostics);
  return inventory.indexes;
}
function publishTopicFile(root: string, relative: string, markdown: string): void {
  fs.mkdirSync(containedEntry(root, path.posix.dirname(relative)).full, { recursive: true });
  try { createExclusive(root, relative, markdown); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new WikiError("conflict", "Existing topic destination: " + relative);
    throw error;
  }
}
function completeTopicPublication(root: string, relative: string, title: string, digest: string, indexes: Map<string, string>): void {
  try {
    for (const [file, bytes] of indexes) fs.writeFileSync(containedEntry(root, file).full, bytes);
    const log = containedEntry(root, "log.md").full;
    const previous = fs.readFileSync(log, "utf8");
    const heading = "## " + new Date().toISOString().slice(0, 10) + "\n\n";
    const entry = "**created** [" + markdownText(title) + "](" + relative + ")\n\n";
    fs.writeFileSync(log, heading + entry + (previous.startsWith(heading) ? previous.slice(heading.length) : previous));
  } catch { throw new CreatePartialError([relative], digest); }
}
/** Caller holds the cooperative mutation lock through validation and all publication effects. */
export function createTopic(root: string, request: CreateRequest) {
  const type = registeredCreateType(root, request.type);
  const relative = topicDestination(root, request, type.record.folder);
  const markdown = topicMarkdown(request, type.record.template);
  const indexes = prospectiveIndexes(root, relative, markdown, request.scope);
  const digest = "sha256:" + createHash("sha256").update(markdown).digest("hex");
  publishTopicFile(root, relative, markdown);
  completeTopicPublication(root, relative, request.title, digest, indexes);
  return { path: relative, title: request.title, description: request.description, digest };
}
