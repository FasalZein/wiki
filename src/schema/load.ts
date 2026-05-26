import { existsSync } from "node:fs";
import matter from "gray-matter";
import { resolve } from "node:path";

import type { Constraints, FieldDef, FieldType, Schema } from "./types";

export function resolveTemplatePath(filename: string): string {
  // Try relative to source first (dev mode), then relative to dist (bundled)
  const fromSrc = resolve(import.meta.dir, "..", "..", "templates", filename);
  if (existsSync(fromSrc)) return fromSrc;
  const fromDist = resolve(import.meta.dir, "..", "templates", filename);
  return fromDist;
}

export type TemplateType = "prd" | "slice" | "decision" | "handover";

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

export async function loadTemplate(type: TemplateType): Promise<Schema> {
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

  return {
    template: parsed.data.template,
    version: parsed.data.version,
    fields: Object.entries(parsed.data.schema).map(([name, raw]) => parseField(type, name, raw)),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
