/**
 * Authored-body parsing for one-shot artifact creation (ADR-0031).
 *
 * A template body has two kinds of H2 sections: authored sections, whose
 * heading sits directly over a `{{placeholder}}` line that is not a schema
 * field (their content comes from the caller), and machine-owned sections
 * rendered by the CLI from fields. `--body` input may only supply authored
 * sections; the mapping is derived from the template so the contract can
 * never drift from it.
 */

export class BodyParseError extends Error {}

export type AuthoredSection = { heading: string; placeholder: string };

const H2_RE = /^## (.+)$/;

export function authoredSections(templateBody: string, schemaFields: Set<string>): AuthoredSection[] {
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

export function parseBodySections(
  templateBody: string,
  schemaFields: Set<string>,
  supplied: string,
): Record<string, string> {
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

  const result: Record<string, string> = {};
  for (const part of parts) {
    const section = byHeading.get(normalize(part.heading));
    if (section !== undefined) {
      result[section.placeholder] = part.content;
      continue;
    }
    if (machineOwned.has(normalize(part.heading))) {
      throw new BodyParseError(
        `body section "## ${part.heading}" is machine-owned and rendered by the CLI — remove it from --body`,
      );
    }
    throw new BodyParseError(`unknown body section "## ${part.heading}"; expected sections: ${expected}`);
  }
  return result;
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
export function bodySectionDrift(
  templateBody: string,
  schemaFields: Set<string>,
  artifactBody: string,
): { missing: string[]; unknown: string[] } {
  const authored = authoredSections(templateBody, schemaFields);
  const authoredSet = new Set(authored.map((section) => normalize(section.heading)));
  const templateSet = new Set(templateHeadings(templateBody).map(normalize));
  const present = new Set(splitByH2(artifactBody).map((part) => normalize(part.heading)));

  const missing = authored.map((s) => s.heading).filter((heading) => !present.has(normalize(heading)));
  const unknown = splitByH2(artifactBody)
    .map((part) => part.heading)
    .filter((heading) => !templateSet.has(normalize(heading)) && !authoredSet.has(normalize(heading)));
  return { missing, unknown };
}
