import { loadRegistry, safeName, type Registry } from "./registry.ts";
import { containedEntry, sha256, WikiError } from "./vault.ts";
import type { HeldLock } from "./mutation.ts";
import { publish, topicLog, validateProspective, ValidationError } from "./publication.ts";

export interface CreateRequest {
  type: string; scope: string; title: string; description: string;
  slug?: string; body?: string; tags?: string[]; status?: string;
}
function registeredCreateType(registry: Registry, name: string) {
  if (registry.diagnostics.length) throw new ValidationError(registry.diagnostics);
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
export function createTopic(lock: HeldLock, request: CreateRequest) {
  const root = lock.root;
  const registry = loadRegistry(root);
  const type = registeredCreateType(registry, request.type);
  const relative = topicDestination(root, request, type.record.folder);
  const markdown = topicMarkdown(request, type.record.template);
  const plan = validateProspective(root, { path: relative, markdown }, "Duplicate normalized title in " + request.scope, registry);
  const digest = sha256(markdown);
  publish(lock, { kind: "create", path: relative, markdown, digest, plan, log: topicLog("created", request.title, relative) });
  return { path: relative, title: request.title, description: request.description, digest };
}
