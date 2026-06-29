import { describe, expect, test } from "bun:test";

import { loadTemplate } from "../src/schema/load";
import type { Schema } from "../src/schema/types";
import { validate } from "../src/schema/validate";

describe("template schemas", () => {
  test("loads every shipped template with declared field constraints", async () => {
    const prd = await loadTemplate("prd");
    const slice = await loadTemplate("slice");
    const decision = await loadTemplate("decision");
    const handoff = await loadTemplate("handoff");

    expect(prd.template).toBe("prd");
    expect(slice.template).toBe("slice");
    expect(decision.template).toBe("decision");
    expect(handoff.template).toBe("handoff");

    const prdId = prd.fields.find((field) => field.name === "id");
    expect(prdId).toEqual({
      name: "id",
      type: "string",
      required: true,
      constraints: {
        pattern: "PRD-\\d{3,}",
        description: "Canonical PRD identifier",
      },
    });

    const sliceStatus = slice.fields.find((field) => field.name === "status");
    expect(sliceStatus).toEqual({
      name: "status",
      type: "enum",
      required: true,
      constraints: {
        values: ["planned", "red", "green", "closed", "blocked", "superseded"],
      },
    });

    expect(decision.fields.length).toBeGreaterThan(0);
    expect(handoff.fields.length).toBeGreaterThan(0);
  });

  test("validates fully populated input and returns the normalized record", async () => {
    const schema = await loadTemplate("handoff");
    const input = {
      id: "HANDOFF-0001",
      project: "wiki-v2",
      title: "Session handoff title",
      summary: "Handoff summary for the session.",
      session_date: "2026-05-25",
      phase: "slice",
      decisions_made: ["ADR-0001"],
      status: "open",
      created: "2026-05-25",
    };

    expect(validate(schema, input)).toEqual({ ok: true, value: input });
  });

  test("rejects input missing a required field with the field name", async () => {
    const schema = await loadTemplate("prd");

    expect(validate(schema, { id: "PRD-001", summary: "A populated summary here.", project: "wiki-v2", status: "draft" })).toEqual({
      ok: false,
      errors: [{ field: "title", reason: "required", expected: "string" }],
    });
  });

  test("rejects a type mismatch with the field name and expected type", async () => {
    const schema = await loadTemplate("slice");

    expect(
      validate(schema, {
        id: "SLICE-001",
        title: "Template schema loader",
        summary: "A populated summary here.",
        project: "wiki-v2",
        parent_prd: "PRD-001",
        status: "planned",
        type: "AFK",
        acceptance: "must be a list",
      }),
    ).toEqual({
      ok: false,
      errors: [{ field: "acceptance", reason: "type mismatch", expected: "list" }],
    });
  });

  test("rejects enum values outside the allowed set with the allowed values", async () => {
    const schema = await loadTemplate("decision");

    expect(
      validate(schema, {
        id: "ADR-0001",
        title: "Template schemas carry validation rules",
        summary: "A populated summary here.",
        project: "wiki-v2",
        status: "maybe",
      }),
    ).toEqual({
      ok: false,
      errors: [
        {
          field: "status",
          reason: "invalid enum value",
          expected: "one of: proposed, accepted, superseded, rejected",
        },
      ],
    });
  });

  test("rejects a list below its minimum count with the field name and minimum", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "tags", type: "list", required: true, constraints: { min: 2 } }],
    };

    expect(validate(schema, { tags: ["only-one"] })).toEqual({
      ok: false,
      errors: [{ field: "tags", reason: "below minimum count", expected: "at least 2 item" }],
    });
  });

  test("rejects a string below its minimum length with the field name and minimum", async () => {
    const schema = await loadTemplate("prd");

    expect(validate(schema, { id: "PRD-001", title: "Tiny", summary: "A populated summary here.", project: "wiki-v2", status: "draft" })).toEqual({
      ok: false,
      errors: [{ field: "title", reason: "below minimum length", expected: "at least 5 characters" }],
    });
  });

  test("rejects pattern mismatches with the field name and pattern", async () => {
    const schema = await loadTemplate("slice");

    expect(
      validate(schema, {
        id: "TASK-001",
        title: "Template schema loader",
        summary: "A populated summary here.",
        project: "wiki-v2",
        parent_prd: "PRD-001",
        status: "planned",
        type: "AFK",
        acceptance: ["schema loads"],
      }),
    ).toEqual({
      ok: false,
      errors: [{ field: "id", reason: "pattern mismatch", expected: "SLICE-\\d{3,}" }],
    });
  });

  test("treats a null optional field as absent, not a type mismatch", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "note", type: "string", required: false, constraints: {} }],
    };

    expect(validate(schema, { note: null })).toEqual({ ok: true, value: { note: null } });
  });

  test("reports a null required field as required, not a type mismatch", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "note", type: "string", required: true, constraints: {} }],
    };

    expect(validate(schema, { note: null })).toEqual({
      ok: false,
      errors: [{ field: "note", reason: "required", expected: "string" }],
    });
  });

  test("enforces max length on string-like fields", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "title", type: "string", required: true, constraints: { min: 5, max: 10 } }],
    };
    expect(validate(schema, { title: "way too long to fit" })).toEqual({
      ok: false,
      errors: [{ field: "title", reason: "above maximum length", expected: "at most 10 characters" }],
    });
    expect(validate(schema, { title: "just ok" }).ok).toBe(true);
  });

  test("enforces max count on list and link_list fields", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "tags", type: "list", required: false, constraints: { max: 2 } }],
    };
    expect(validate(schema, { tags: ["a", "b", "c"] })).toEqual({
      ok: false,
      errors: [{ field: "tags", reason: "above maximum count", expected: "at most 2 item" }],
    });
  });

  test("enforces integer min/max range", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "n", type: "integer", required: true, constraints: { min: 1, max: 5 } }],
    };
    expect(validate(schema, { n: 9 })).toEqual({
      ok: false,
      errors: [{ field: "n", reason: "above maximum", expected: "at most 5" }],
    });
    expect(validate(schema, { n: 0 })).toEqual({
      ok: false,
      errors: [{ field: "n", reason: "below minimum", expected: "at least 1" }],
    });
    expect(validate(schema, { n: 3 }).ok).toBe(true);
  });

  test("rejects a non-string (Date) value on an enum field", () => {
    const schema: Schema = {
      template: "synthetic",
      version: 1,
      fields: [{ name: "status", type: "enum", required: true, constraints: { values: ["open", "closed"] } }],
    };
    expect(validate(schema, { status: new Date() })).toEqual({
      ok: false,
      errors: [{ field: "status", reason: "invalid enum value", expected: "one of: open, closed" }],
    });
  });
});
