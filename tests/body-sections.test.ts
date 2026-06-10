import { describe, expect, test } from "bun:test";

import { authoredSections, BodyParseError, parseBodySections } from "../src/artifacts/body";

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
    expect(result.what_to_build).toBe("Parse `--body` on create.\n\n### Detail\n\nMore prose.");
  });

  test("ignores content before the first H2 heading", () => {
    const supplied = "# My own title\n\nintro text\n\n## What to build\n\nThe feature.\n";
    const result = parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied);
    expect(result.what_to_build).toBe("The feature.");
  });

  test("matches headings case-insensitively", () => {
    const supplied = "## what to BUILD\n\nThe feature.\n";
    const result = parseBodySections(SLICE_TEMPLATE_BODY, SLICE_FIELDS, supplied);
    expect(result.what_to_build).toBe("The feature.");
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
