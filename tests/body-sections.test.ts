import { describe, expect, test } from "bun:test";

import { authoredSections, BodyParseError, parseBodySections } from "../src/artifacts/body";
import type { FieldType } from "../src/schema/types";

const SLICE_TEMPLATE_BODY = [
  "# {{title}}",
  "",
  "## Parent",
  "",
  "[[{{parent_prd}}]]",
  "",
  "## What to build",
  "",
  "{{what_to_build}}",
  "",
  "> A concise description of this vertical slice.",
  "",
  "## Acceptance criteria",
  "",
  "{{#each acceptance}}- [ ] {{this}}",
  "{{/each}}",
  "",
  "## Todo",
  "",
  "- [ ] Write tests",
].join("\n");

const SLICE_FIELDS = new Set(["title", "parent_prd", "acceptance", "status"]);

describe("authoredSections", () => {
  test("derives heading-to-placeholder mapping for non-schema placeholders", () => {
    const sections = authoredSections(SLICE_TEMPLATE_BODY, SLICE_FIELDS);
    expect(sections).toEqual([{ heading: "What to build", placeholder: "what_to_build" }]);
  });

  test("treats headings over schema-field placeholders and each-blocks as machine-owned", () => {
    const headings = authoredSections(SLICE_TEMPLATE_BODY, SLICE_FIELDS).map((s) => s.heading);
    expect(headings).not.toContain("Parent");
    expect(headings).not.toContain("Acceptance criteria");
    expect(headings).not.toContain("Todo");
  });
});

describe("parseBodySections", () => {
  test("maps supplied sections to placeholders, preserving content verbatim", () => {
    const supplied = "## What to build\n\nParse `--body` on create.\n\n### Detail\n\nMore prose.\n";
    const result = parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied);
    expect(result.sections.what_to_build).toBe("Parse `--body` on create.\n\n### Detail\n\nMore prose.");
  });

  test("ignores content before the first H2 heading", () => {
    const supplied = "# My own title\n\nintro text\n\n## What to build\n\nThe feature.\n";
    const result = parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied);
    expect(result.sections.what_to_build).toBe("The feature.");
  });

  test("matches headings case-insensitively", () => {
    const supplied = "## what to BUILD\n\nThe feature.\n";
    const result = parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied);
    expect(result.sections.what_to_build).toBe("The feature.");
  });

  test("rejects a machine-owned heading, naming it", () => {
    const supplied = "## What to build\n\nx\n\n## Todo\n\n- [ ] my own todo\n";
    expect(() => parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied)).toThrow(BodyParseError);
    expect(() => parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied)).toThrow(/## Todo.*machine-owned/);
  });

  test("rejects an unknown heading, listing the expected sections", () => {
    const supplied = "## Random section\n\nx\n";
    expect(() => parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied)).toThrow(/## Random section/);
    expect(() => parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied)).toThrow(/## What to build/);
  });

  test("rejects an empty body", () => {
    expect(() => parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, "  \n")).toThrow(BodyParseError);
  });
});

describe("parseBodySections — machine-owned absorption (link_list)", () => {
  // A template whose machine-owned "Decisions" section renders from a link_list field.
  const HANDOFF_BODY = [
    "# {{title}}",
    "",
    "## What produced",
    "",
    "{{produced}}",
    "",
    "## Decisions",
    "",
    "{{#each decisions_made}}- [[{{this}}]]",
    "{{else}}_None this session._",
    "{{/each}}",
  ].join("\n");
  // produced is an authored placeholder (not a schema field); decisions_made is the link_list field.
  const FIELDS = new Set(["title", "decisions_made"]);
  const TYPES = new Map<string, FieldType>([["decisions_made", "link_list"]]);

  test("absorbs a derivable wikilink section into its backing field, dropping it from the body", () => {
    const supplied = "## Decisions\n\n- [[ADR-0001]]\n- [[ADR-0002]]\n";
    const result = parseBodySections(HANDOFF_BODY, FIELDS, supplied, TYPES);
    expect(result.absorbed.decisions_made).toEqual(["ADR-0001", "ADR-0002"]);
    expect(result.sections).toEqual({}); // the section is not carried as authored body
  });

  test("rejects prose in a machine-owned section, naming the backing flag and authorable sections", () => {
    const supplied = "## Decisions\n\nWe decided to ship it.\n";
    expect(() => parseBodySections(HANDOFF_BODY, FIELDS, supplied, TYPES)).toThrow(/--decisions-made/);
    expect(() => parseBodySections(HANDOFF_BODY, FIELDS, supplied, TYPES)).toThrow(/Authorable sections/);
  });

  test("without field types, a machine-owned section is rejected (no absorption)", () => {
    const supplied = "## Decisions\n\n- [[ADR-0001]]\n";
    expect(() => parseBodySections(HANDOFF_BODY, FIELDS, supplied)).toThrow(/machine-owned/);
  });
});
