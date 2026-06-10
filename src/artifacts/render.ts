import matter from "gray-matter";

import { normalizeInlineMaps } from "../schema/load";
import type { NormalizedRecord, Schema } from "../schema/types";

export function renderArtifact(
  template: string,
  values: NormalizedRecord,
  bodySections?: Record<string, string>,
): string {
  const parsed = matter(normalizeInlineMaps(template));
  // Templater scripts are for manual creation inside Obsidian only — leaked
  // into a rendered artifact they execute on file creation and prompt the user.
  const noTemplater = parsed.content.replace(/<!--\s*<%\*[\s\S]*?-->\n*/g, "");
  const stripped = stripGuidanceForFilled(noTemplater, bodySections);
  const withLists = renderEachBlocks(stripped, values);
  const body = withLists.replace(/{{([A-Za-z0-9_]+)}}/g, (_placeholder: string, name: string) => {
    const section = bodySections?.[name];
    if (section !== undefined) {
      return section;
    }
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

/**
 * Remove the authoring-guidance blockquote that follows a `{{placeholder}}`
 * line for every placeholder that received body content — the guidance is
 * for an author filling the section in, not for a filled artifact.
 */
function stripGuidanceForFilled(body: string, bodySections?: Record<string, string>): string {
  if (bodySections === undefined) {
    return body;
  }
  let result = body;
  for (const name of Object.keys(bodySections)) {
    const guidanceRe = new RegExp(`({{${name}}})\\n\\n(?:>.*\\n?)+`);
    result = result.replace(guidanceRe, "$1\n");
  }
  return result;
}

/**
 * Expand `{{#each field}}…{{else}}…{{/each}}` blocks: the each branch repeats
 * per list item with `{{this}}` substituted; the else branch renders when the
 * field is missing, not a list, or empty. Runs before the plain-placeholder
 * pass so `{{this}}` never leaks into it.
 */
function renderEachBlocks(body: string, values: NormalizedRecord): string {
  const blockRe = /{{#each ([A-Za-z0-9_]+)}}([\s\S]*?)(?:{{else}}([\s\S]*?))?{{\/each}}/g;
  return body.replace(blockRe, (_block: string, name: string, item: string, elseBranch: string | undefined) => {
    const value = values[name];
    if (Array.isArray(value) && value.length > 0) {
      return value.map((entry) => item.replace(/{{this}}/g, String(entry))).join("");
    }
    return elseBranch ?? "";
  });
}

/**
 * Canonical frontmatter order: schema declaration order first (id leads),
 * then any unknown fields in their original relative order.
 */
export function orderBySchema(schema: Schema, record: NormalizedRecord): NormalizedRecord {
  const schemaNames = schema.fields.map((field) => field.name);
  const known = new Set(schemaNames);
  const ordered: NormalizedRecord = {};
  for (const name of schemaNames) {
    if (record[name] !== undefined) ordered[name] = record[name];
  }
  for (const name of Object.keys(record)) {
    if (!known.has(name)) ordered[name] = record[name];
  }
  return ordered;
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
    } else if (field.name === "created" || field.name === "updated" || field.name === "session_date") {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
