import matter from "gray-matter";

import type { Constraints, FieldDef, FieldType, Schema } from "./types";

export type TemplateType = "prd" | "slice" | "decision" | "handover";

type RawField = {
  type?: unknown;
  required?: unknown;
  min?: unknown;
  max?: unknown;
  values?: unknown;
  pattern?: unknown;
  target?: unknown;
  item_type?: unknown;
  description?: unknown;
};

const fieldTypes = new Set<FieldType>([
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
  const file = Bun.file(new URL(`../../templates/${type}.md`, import.meta.url));
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

  const field = raw as RawField;
  if (typeof field.type !== "string" || !fieldTypes.has(field.type as FieldType)) {
    throw new Error(`Template ${template} field ${name} has unsupported type`);
  }

  return {
    name,
    type: field.type as FieldType,
    required: field.required === true,
    constraints: parseConstraints(field),
  };
}

function parseConstraints(field: RawField): Constraints {
  const constraints: Constraints = {};
  if (typeof field.min === "number") constraints.min = field.min;
  if (typeof field.max === "number") constraints.max = field.max;
  if (Array.isArray(field.values) && field.values.every((value) => typeof value === "string")) {
    constraints.values = field.values;
  }
  if (typeof field.pattern === "string") constraints.pattern = field.pattern;
  if (typeof field.target === "string") constraints.target = field.target;
  if (typeof field.item_type === "string" && fieldTypes.has(field.item_type as FieldType)) {
    constraints.item_type = field.item_type as FieldType;
  }
  if (typeof field.description === "string") constraints.description = field.description;
  return constraints;
}

function normalizeInlineMaps(template: string): string {
  return template.replace(/^(\s*[A-Za-z0-9_]+):(\{)/gm, "$1: $2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
