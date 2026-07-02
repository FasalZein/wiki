import { describe, expect, test } from "bun:test";

import { BodyParseError, loadKind } from "../src/artifacts/body";

// The section-contract behaviour (formerly the free-floating body.ts functions)
// is now reached through the compiled Kind, against the real templates it ships
// with — no synthetic template bodies. `slice` has exactly one authored section
// (## What to build); every other H2 is machine-owned.

describe("Kind.authoredSections (slice)", () => {
  test("derives heading-to-placeholder mapping for non-schema placeholders", async () => {
    const kind = await loadKind("slice");
    expect(kind.authoredSections()).toEqual([{ heading: "What to build", placeholder: "what_to_build" }]);
  });

  test("treats headings over schema-field placeholders and each-blocks as machine-owned", async () => {
    const kind = await loadKind("slice");
    const headings = kind.authoredSections().map((s) => s.heading);
    expect(headings).not.toContain("Parent");
    expect(headings).not.toContain("Acceptance criteria");
    expect(headings).not.toContain("Todo");
  });
});

describe("Kind.parseBody (slice)", () => {
  test("maps supplied sections to placeholders, preserving content verbatim", async () => {
    const kind = await loadKind("slice");
    const supplied = "## What to build\n\nParse `--body` on create.\n\n### Detail\n\nMore prose.\n";
    expect(kind.parseBody(supplied).sections.what_to_build).toBe("Parse `--body` on create.\n\n### Detail\n\nMore prose.");
  });

  test("ignores content before the first H2 heading", async () => {
    const kind = await loadKind("slice");
    const supplied = "# My own title\n\nintro text\n\n## What to build\n\nThe feature.\n";
    expect(kind.parseBody(supplied).sections.what_to_build).toBe("The feature.");
  });

  test("matches headings case-insensitively", async () => {
    const kind = await loadKind("slice");
    expect(kind.parseBody("## what to BUILD\n\nThe feature.\n").sections.what_to_build).toBe("The feature.");
  });

  test("rejects a machine-owned heading, naming it", async () => {
    const kind = await loadKind("slice");
    const supplied = "## What to build\n\nx\n\n## Todo\n\n- [ ] my own todo\n";
    expect(() => kind.parseBody(supplied)).toThrow(BodyParseError);
    expect(() => kind.parseBody(supplied)).toThrow(/## Todo.*machine-owned/);
  });

  test("rejects an unknown heading, listing the expected sections", async () => {
    const kind = await loadKind("slice");
    const supplied = "## Random section\n\nx\n";
    expect(() => kind.parseBody(supplied)).toThrow(/## Random section/);
    expect(() => kind.parseBody(supplied)).toThrow(/## What to build/);
  });

  test("rejects an empty body", async () => {
    const kind = await loadKind("slice");
    expect(() => kind.parseBody("  \n")).toThrow(BodyParseError);
  });
});

describe("Kind.parseBody — machine-owned absorption (handoff)", () => {
  // handoff's "## Decisions locked" renders from the decisions_made link_list.
  test("absorbs a derivable wikilink section into its backing field, dropping it from the body", async () => {
    const kind = await loadKind("handoff");
    const supplied = "## Decisions locked\n\n- [[ADR-0001]]\n- [[ADR-0002]]\n";
    const result = kind.parseBody(supplied);
    expect(result.absorbed.decisions_made).toEqual(["ADR-0001", "ADR-0002"]);
    expect(result.sections).toEqual({}); // not carried as authored body
  });

  test("rejects prose in a machine-owned section, naming the backing flag and authorable sections", async () => {
    const kind = await loadKind("handoff");
    const supplied = "## Decisions locked\n\nWe decided to ship it.\n";
    expect(() => kind.parseBody(supplied)).toThrow(/--decisions-made/);
    expect(() => kind.parseBody(supplied)).toThrow(/Authorable sections/);
  });
});
