import { describe, expect, test } from "bun:test";
import matter from "gray-matter";

import { loadKind } from "../src/artifacts/body";

// The compiled Kind interface (ADR-0045 item 1), tested in-process against the
// shipped templates — no subprocess, no temp vault.

describe("Kind.bodySections", () => {
  test("decision: Context/Decision/Consequences are authorable", async () => {
    const kind = await loadKind("decision");
    expect(kind.bodySections().authorable).toEqual(["Context", "Decision", "Consequences"]);
  });

  test("handoff: 'Decisions locked' is machine-owned, backed by decisions_made", async () => {
    const kind = await loadKind("handoff");
    const machine = kind.bodySections().machineOwned.find((m) => m.heading === "Decisions locked");
    expect(machine).toEqual({ heading: "Decisions locked", flags: ["--decisions-made"] });
    expect(kind.bodySections().authorable).toContain("What this session produced");
  });
});

describe("Kind.sectionDrift", () => {
  test("flags an alien H2 the template doesn't define", async () => {
    const kind = await loadKind("decision");
    const body = "## Context\n\nx\n\n## Decision\n\ny\n\n## Consequences\n\nz\n\n## Bananas\n\nnope\n";
    const drift = kind.sectionDrift(body);
    expect(drift.unknown).toContain("Bananas");
    expect(drift.missing).toEqual([]);
  });

  test("flags a removed authored section as missing", async () => {
    const kind = await loadKind("decision");
    const drift = kind.sectionDrift("## Context\n\nx\n\n## Decision\n\ny\n");
    expect(drift.missing).toContain("Consequences");
  });
});

describe("loadKind caching", () => {
  test("returns the same object for the same kind", async () => {
    expect(await loadKind("decision")).toBe(await loadKind("decision"));
  });
});

describe("Kind.render", () => {
  test("round-trips authored sections into a drift-free body", async () => {
    const kind = await loadKind("decision");
    const values = {
      id: "ADR-0999",
      title: "A test decision",
      summary: "A one-line summary of the decision.",
      status: "accepted",
      project: "wiki-v2",
      updated: "2026-07-02",
    };
    const rendered = kind.render(values, {
      context: "The context prose.",
      decision: "The decision prose.",
      consequences: "The consequences prose.",
    });
    const body = matter(rendered).content;
    expect(body).toContain("## Context\n\nThe context prose.");
    expect(body).not.toContain("{{");
    expect(kind.sectionDrift(body)).toEqual({ missing: [], unknown: [] });
  });
});
