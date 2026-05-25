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

export function applyDefaults(schema: Schema, input: Record<string, unknown>): NormalizedRecord {
  const values: NormalizedRecord = { ...input };
  const today = new Date().toISOString().slice(0, 10);

  for (const field of schema.fields) {
    if (values[field.name] !== undefined) {
      continue;
    }
    if (field.constraints.default !== undefined) {
      values[field.name] = field.constraints.default;
    } else if (field.name === "created" || field.name === "updated") {
      values[field.name] = today;
    } else if (field.type === "list" || field.type === "link_list") {
      values[field.name] = [];
    }
  }

  return values;
}

function normalizeInlineMaps(template: string): string {
  return template.replace(/^(\s*[A-Za-z0-9_]+):(\{)/gm, "$1: $2");
}
