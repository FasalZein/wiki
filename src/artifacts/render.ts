import matter from "gray-matter";

import type { NormalizedRecord, Schema } from "../schema/types";

export function renderArtifact(template: string, values: NormalizedRecord): string {
  const parsed = matter(normalizeInlineMaps(template));
  const body = parsed.content.replace(/{{([A-Za-z0-9_]+)}}/g, (_placeholder: string, name: string) => {
    if (name === "date") {
      const updated = values.updated;
      return typeof updated === "string" ? updated : "";
    }
    const value = values[name];
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    if (value === undefined) {
      return "";
    }
    return String(value);
  });

  return `${matter.stringify(body.trimStart(), values)}\n`;
}

export function applyDefaults(schema: Schema, template: string, input: Record<string, unknown>): NormalizedRecord {
  const values: NormalizedRecord = { ...input };
  const today = new Date().toISOString().slice(0, 10);

  const templateDefaults = readTemplateDefaults(template);

  for (const field of schema.fields) {
    if (values[field.name] !== undefined) {
      continue;
    }
    const templateDefault = templateDefaults[field.name];
    if (templateDefault !== undefined) {
      values[field.name] = templateDefault;
    } else if (field.name === "created" || field.name === "updated") {
      values[field.name] = today;
    } else if (field.type === "list" || field.type === "link_list") {
      values[field.name] = [];
    }
  }

  return values;
}

function readTemplateDefaults(template: string): Record<string, unknown> {
  const parsed = matter(normalizeInlineMaps(template));
  const rawSchema = parsed.data.schema;
  if (!isRecord(rawSchema)) {
    return {};
  }
  const defaults: Record<string, unknown> = {};
  for (const [fieldName, rawField] of Object.entries(rawSchema)) {
    if (isRecord(rawField) && rawField.default !== undefined) {
      defaults[fieldName] = rawField.default;
    }
  }
  return defaults;
}

function normalizeInlineMaps(template: string): string {
  return template.replace(/^(\s*[A-Za-z0-9_]+):(\s*\{)/gm, "$1: $2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
