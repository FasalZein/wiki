import { existsSync } from "node:fs";
import matter from "gray-matter";
import { resolve } from "node:path";

import type { Constraints, FieldDef, FieldType, Schema } from "./types";
import { isRecord } from "../util";

function resolveTemplatePath(filename: string): string {
  // Dev mode: src/schema/ -> ../../templates. Bundled: dist/ -> ./templates
  // (the build copies templates/ into dist/templates so a relocated dist works).
  const fromSrc = resolve(import.meta.dir, "..", "..", "templates", filename);
  if (existsSync(fromSrc)) return fromSrc;
  return resolve(import.meta.dir, "templates", filename);
}

/**
 * A kind id (e.g. "prd", "handoff"). Kinds are defined in wiki.json and validated
 * at runtime against the loaded registry + a matching templates/<kind>.md — not a
 * compile-time union, so a skill can add a kind by config without touching the type.
 */
export type TemplateType = string;

const fieldTypes: ReadonlySet<string> = new Set<FieldType>([
  "string",
  "text",
  "list",
  "link",
  "link_list",
  "enum",
  "boolean",
  "date",
  "integer",
  "file_ref",
]);

/**
 * The whole compiled template — everything one file-read + one matter-parse
 * yields. `loadKind` (src/artifacts/body.ts) wraps this with the section-contract
 * and render behaviour; callers never re-read the file or re-run `matter`.
 */
export type CompiledTemplate = {
  schema: Schema;
  /** The template body (frontmatter stripped), source for the section contract. */
  templateBody: string;
  /** Per-field `default:` values declared in the template's schema frontmatter. */
  templateDefaults: Record<string, unknown>;
};

// Templates are immutable data shipped beside the binary (resolveTemplatePath
// never reads the vault), so the parse is identical for a given kind across the
// whole run — memoize it here so create/fmt/store/mutate/validate share one
// parse instead of each re-reading the file. Replaces fmt's bespoke schemaCache.
const templateCache = new Map<TemplateType, Promise<CompiledTemplate>>();

export function loadTemplate(type: TemplateType): Promise<Schema> {
  return loadCompiledTemplate(type).then((compiled) => compiled.schema);
}

export function loadCompiledTemplate(type: TemplateType): Promise<CompiledTemplate> {
  let cached = templateCache.get(type);
  if (cached === undefined) {
    cached = parseTemplate(type);
    templateCache.set(type, cached);
  }
  return cached;
}

async function parseTemplate(type: TemplateType): Promise<CompiledTemplate> {
  const file = Bun.file(resolveTemplatePath(`${type}.md`));
  const parsed = matter(normalizeInlineMaps(await file.text()));

  if (typeof parsed.data.template !== "string") {
    throw new Error(`Template ${type} is missing template name`);
  }
  if (typeof parsed.data.version !== "number") {
    throw new Error(`Template ${type} is missing version`);
  }
  if (!isRecord(parsed.data.schema)) {
    throw new Error(`Template ${type} is missing schema`);
  }

  const schema: Schema = {
    template: parsed.data.template,
    version: parsed.data.version,
    fields: Object.entries(parsed.data.schema).map(([name, raw]) => parseField(type, name, raw)),
  };
  const templateDefaults: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(parsed.data.schema)) {
    if (isRecord(raw) && raw.default !== undefined) templateDefaults[name] = raw.default;
  }
  return { schema, templateBody: parsed.content, templateDefaults };
}

function parseField(template: string, name: string, raw: unknown): FieldDef {
  if (!isRecord(raw)) {
    throw new Error(`Template ${template} field ${name} must be an object`);
  }

  const fieldType = raw.type;
  if (!isFieldType(fieldType)) {
    throw new Error(`Template ${template} field ${name} has unsupported type`);
  }

  return {
    name,
    type: fieldType,
    required: raw.required === true,
    ...(raw.auto === true ? { auto: true } : {}),
    constraints: parseConstraints(raw),
  };
}

function parseConstraints(raw: Record<string, unknown>): Constraints {
  const constraints: Constraints = {};
  if (typeof raw.min === "number") constraints.min = raw.min;
  if (typeof raw.max === "number") constraints.max = raw.max;
  if (Array.isArray(raw.values) && raw.values.every((value): value is string => typeof value === "string")) {
    constraints.values = raw.values;
  }
  if (typeof raw.pattern === "string") constraints.pattern = raw.pattern;
  if (typeof raw.target === "string") constraints.target = raw.target;
  if (isFieldType(raw.item_type)) {
    constraints.item_type = raw.item_type;
  }
  if (typeof raw.description === "string") constraints.description = raw.description;
  return constraints;
}

function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && fieldTypes.has(value);
}

function normalizeInlineMaps(template: string): string {
  return template.replace(/^(\s*[A-Za-z0-9_]+):(\s*\{)/gm, "$1: $2");
}
