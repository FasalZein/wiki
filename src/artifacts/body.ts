/**
 * The compiled Kind (ADR-0045 item 1): schema + template body + section
 * contract + render behind one cached interface. `loadKind(type)` is the single
 * seam create/validate/schema/fmt/store ask instead of each re-running the
 * loadTemplate + Bun.file().text() + matter(normalizeInlineMaps(...)) + Set
 * ritual — so the section contract has exactly one definition.
 *
 * A template body has two kinds of H2 sections: authored sections, whose
 * heading sits directly over a `{{placeholder}}` line that is not a schema
 * field (their content comes from the caller), and machine-owned sections
 * rendered by the CLI from fields. `--body` input may only supply authored
 * sections; the mapping is derived from the template so the contract can
 * never drift from it. The four section functions below are the private
 * implementation of the Kind's section methods (ADR-0031/ADR-0044).
 */

import { loadCompiledTemplate, type TemplateType } from "../schema/load";
import type { FieldType, NormalizedRecord, Schema } from "../schema/types";
import { validate } from "../schema/validate";
import { applyDefaults, renderArtifact } from "./render";

export class BodyParseError extends Error {}

export type AuthoredSection = { heading: string; placeholder: string };

/** What {@link parseBodySections} yields: authored sections keyed by placeholder,
 *  plus any machine-owned section whose authored content was DERIVABLE into its
 *  backing schema field (absorbed) rather than rejected. */
export type ParsedBody = { sections: Record<string, string>; absorbed: Record<string, unknown> };

/**
 * A compiled kind: the schema, the field-name set, the parsed template body, and
 * the section-contract + render + validate methods every verb needs. One file
 * read + one matter parse per kind per process (memoized via loadCompiledTemplate
 * and the kind cache below).
 */
export type Kind = {
  schema: Schema;
  fieldNames: Set<string>;
  templateBody: string;
  /** Headings an author supplies via `--body` (heading over a non-field placeholder). */
  authoredSections(): AuthoredSection[];
  /** The authorable/machine-owned split, each machine-owned section with its flags. */
  bodySections(): BodySectionInfo;
  /** Required sections missing from a rendered body, and unknown ones added. */
  sectionDrift(artifactBody: string): { missing: string[]; unknown: string[] };
  /** Parse `--body` into placeholder sections + absorbed machine-owned fields. */
  parseBody(supplied: string): ParsedBody;
  /** Render the template body with values (and any authored sections) into an artifact. */
  render(values: NormalizedRecord, sections?: Record<string, string>): string;
  /** Fill schema/template defaults onto an input record. */
  applyDefaults(input: Record<string, unknown>): NormalizedRecord;
  /** Validate a field record against this kind's schema. */
  validate(fields: Record<string, unknown>): ReturnType<typeof validate>;
};

// Keyed on vaultRoot+type (F1): a vault-shipped template must not be poisoned by a
// bundled-kind entry parsed earlier in the same process (bun test spans many vaults).
const kindCache = new Map<string, Promise<Kind>>();

export function loadKind(type: TemplateType, vaultRoot?: string): Promise<Kind> {
  const key = `${vaultRoot ?? ""} ${type}`;
  let cached = kindCache.get(key);
  if (cached === undefined) {
    cached = buildKind(type, vaultRoot);
    kindCache.set(key, cached);
  }
  return cached;
}

async function buildKind(type: TemplateType, vaultRoot?: string): Promise<Kind> {
  const { schema, templateBody, templateDefaults } = await loadCompiledTemplate(type, vaultRoot);
  const fieldNames = new Set(schema.fields.map((field) => field.name));
  const fieldTypes = new Map(schema.fields.map((field) => [field.name, field.type]));
  return {
    schema,
    fieldNames,
    templateBody,
    authoredSections: () => authoredSections(templateBody, fieldNames),
    bodySections: () => classifyBodySections(templateBody, fieldNames),
    sectionDrift: (artifactBody) => bodySectionDrift(templateBody, fieldNames, artifactBody),
    parseBody: (supplied) => parseBodySections(templateBody, fieldNames, supplied, fieldTypes),
    render: (values, sections) => renderArtifact(templateBody, values, sections),
    applyDefaults: (input) => applyDefaults(schema, templateDefaults, input),
    validate: (fields) => validate(schema, fields),
  };
}

const H2_RE = /^## (.+)$/;

function authoredSections(templateBody: string, schemaFields: Set<string>): AuthoredSection[] {
  const sections: AuthoredSection[] = [];
  const lines = templateBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i]?.match(H2_RE)?.[1];
    if (heading === undefined) continue;
    let j = i + 1;
    while (j < lines.length && lines[j]?.trim() === "") j++;
    const placeholder = lines[j]?.match(/^{{([A-Za-z0-9_]+)}}$/)?.[1];
    if (placeholder !== undefined && !schemaFields.has(placeholder)) {
      sections.push({ heading: heading.trim(), placeholder });
    }
  }
  return sections;
}

function parseBodySections(
  templateBody: string,
  schemaFields: Set<string>,
  supplied: string,
  fieldTypes?: Map<string, FieldType>,
): ParsedBody {
  const authored = authoredSections(templateBody, schemaFields);
  const expected = authored.map((section) => `## ${section.heading}`).join(", ");
  if (supplied.trim().length === 0) {
    throw new BodyParseError(`--body is empty; expected sections: ${expected}`);
  }

  const byHeading = new Map(authored.map((section) => [normalize(section.heading), section]));
  const machineOwned = new Set(
    templateHeadings(templateBody)
      .map(normalize)
      .filter((heading) => !byHeading.has(heading)),
  );

  const parts = splitByH2(supplied);
  if (parts.length === 0) {
    throw new BodyParseError(`no H2 sections found in --body; expected sections: ${expected}`);
  }

  const sections: Record<string, string> = {};
  const absorbed: Record<string, unknown> = {};
  for (const part of parts) {
    const section = byHeading.get(normalize(part.heading));
    if (section !== undefined) {
      sections[section.placeholder] = part.content;
      continue;
    }
    if (machineOwned.has(normalize(part.heading))) {
      // Absorb instead of reject when the authored content is DERIVABLE into the
      // section's backing field: exactly one link_list field rendered from pure
      // [[ID]] wikilinks. The ids land in that field and the section drops from the
      // body (rendered canonically from the field). Prose (non-wikilink content) or
      // any other backing shape is still rejected — the author can't hand-write what
      // the CLI owns.
      const backing = machineOwnedFieldNames(templateBody, schemaFields, part.heading);
      if (backing.length === 1 && fieldTypes?.get(backing[0]!) === "link_list") {
        const ids = parseWikilinkList(part.content);
        if (ids !== null) {
          absorbed[backing[0]!] = ids;
          continue;
        }
      }
      const flags = machineOwnedFlags(templateBody, schemaFields, part.heading);
      const flagHint = flags.length > 0
        ? `set that content with ${flags.join(" / ")}, not by authoring this section`
        : "remove it from --body";
      const authorHint = authored.length > 0 ? ` Authorable sections: ${expected}.` : "";
      throw new BodyParseError(
        `body section "## ${part.heading}" is machine-owned and rendered by the CLI — ${flagHint}.${authorHint}`,
      );
    }
    throw new BodyParseError(`unknown body section "## ${part.heading}"; expected sections: ${expected}`);
  }
  return { sections, absorbed };
}

/**
 * Parse a machine-owned section's authored content as a link_list value: the bare
 * ids of `[[ID]]` wikilinks (one per line, optional `-`/`*` bullet), skipping a lone
 * italic `_none_` marker (the template's `{{else}}` fallback). Returns null when ANY
 * non-empty line is not a wikilink — i.e. the content is prose, not derivable — so the
 * caller rejects it. An all-marker/empty section absorbs as `[]`.
 */
function parseWikilinkList(content: string): string[] | null {
  const ids: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const item = line.replace(/^[-*]\s+/, "");
    if (/^_.*_$/.test(item)) continue; // the {{else}} "_None …_" fallback marker
    const match = item.match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
    if (match === null) return null; // prose — not derivable into a link_list
    ids.push(match[1]!.trim());
  }
  return ids;
}

/**
 * BUG-E / addendum (ADR-0044): classify a template's H2 sections into the ones an
 * author supplies via `--body` (authorable — a heading over a non-field
 * `{{placeholder}}`) and the ones the CLI renders from fields (machine-owned).
 * Each machine-owned section carries the flag(s) that set its content, so
 * `wiki schema` and the reject error can point the author at the right flag.
 */
export type BodySectionInfo = {
  authorable: string[];
  machineOwned: Array<{ heading: string; flags: string[] }>;
};

function classifyBodySections(templateBody: string, schemaFields: Set<string>): BodySectionInfo {
  const authored = new Set(authoredSections(templateBody, schemaFields).map((s) => normalize(s.heading)));
  const authorable: string[] = [];
  const machineOwned: Array<{ heading: string; flags: string[] }> = [];
  for (const part of splitByH2(templateBody)) {
    if (authored.has(normalize(part.heading))) {
      authorable.push(part.heading);
    } else {
      machineOwned.push({
        heading: part.heading,
        flags: fieldNamesIn(part.content, schemaFields).map((name) => `--${name.replace(/_/g, "-")}`),
      });
    }
  }
  return { authorable, machineOwned };
}

/** The flags (`--field-name`) that render a machine-owned section named `heading`. */
function machineOwnedFlags(templateBody: string, schemaFields: Set<string>, heading: string): string[] {
  return machineOwnedFieldNames(templateBody, schemaFields, heading).map((name) => `--${name.replace(/_/g, "-")}`);
}

/** Schema field names referenced in a machine-owned section's template content. */
function machineOwnedFieldNames(templateBody: string, schemaFields: Set<string>, heading: string): string[] {
  const part = splitByH2(templateBody).find((p) => normalize(p.heading) === normalize(heading));
  return part === undefined ? [] : fieldNamesIn(part.content, schemaFields);
}

/** Schema fields referenced in a section's template content. Catches both `{{field}}`
 *  and `{{#each field}}` forms; `{{this}}`/`{{else}}` are dropped. */
function fieldNamesIn(content: string, schemaFields: Set<string>): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/{{\s*(?:#each\s+)?([A-Za-z0-9_]+)/g)) {
    const name = match[1];
    if (name !== undefined && schemaFields.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

function templateHeadings(templateBody: string): string[] {
  return templateBody.split("\n").flatMap((line) => {
    const match = line.match(H2_RE);
    return match?.[1] === undefined ? [] : [match[1].trim()];
  });
}

function splitByH2(supplied: string): Array<{ heading: string; content: string }> {
  const parts: Array<{ heading: string; content: string }> = [];
  let current: { heading: string; lines: string[] } | undefined;
  for (const line of supplied.split("\n")) {
    const heading = line.match(H2_RE)?.[1];
    if (heading !== undefined) {
      if (current !== undefined) {
        parts.push({ heading: current.heading, content: current.lines.join("\n").trim() });
      }
      current = { heading: heading.trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current !== undefined) {
    parts.push({ heading: current.heading, content: current.lines.join("\n").trim() });
  }
  return parts;
}

function normalize(heading: string): string {
  return heading.trim().toLowerCase();
}

/**
 * Compare a rendered artifact body against its template's section contract
 * (the same one `create` enforces). "missing" = an authored section (one a user
 * must supply — the heading over a non-field `{{placeholder}}`) absent from the
 * body. "unknown" = a body section the template doesn't define at all (neither
 * authored nor machine-owned). Machine-owned sections (rendered by the CLI) are
 * not required after edits. Heading match is case-insensitive; order isn't enforced.
 */
function bodySectionDrift(
  templateBody: string,
  schemaFields: Set<string>,
  artifactBody: string,
): { missing: string[]; unknown: string[] } {
  const authored = authoredSections(templateBody, schemaFields);
  const templateSet = new Set(templateHeadings(templateBody).map(normalize));
  const present = new Set(splitByH2(artifactBody).map((part) => normalize(part.heading)));

  const missing = authored.map((s) => s.heading).filter((heading) => !present.has(normalize(heading)));
  // authoredSet ⊆ templateSet (authored headings come from the template), so the
  // templateSet check alone covers both — a heading absent from the template.
  const unknown = splitByH2(artifactBody)
    .map((part) => part.heading)
    .filter((heading) => !templateSet.has(normalize(heading)));
  return { missing, unknown };
}
