import { describe, expect, test } from "bun:test";

import { loadTemplate } from "../src/schema/load";
import type { Schema } from "../src/schema/types";
import { validate } from "../src/schema/validate";

describe("template schemas", () => {
  test("loads every shipped template with declared field constraints", async () => {
    const prd = await loadTemplate("prd");
    const slice = await loadTemplate("slice");
    const decision = await loadTemplate("decision");
    const handover = await loadTemplate("handover");

    expect(prd.template).toBe("prd");
    expect(slice.template).toBe("slice");
    expect(decision.template).toBe("decision");
    expect(handover.template).toBe("handover");

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
        values: ["planned", "red", "green", "closed", "blocked"],
      },
    });

    expect(decision.fields.length).toBeGreaterThan(0);
    expect(handover.fields.length).toBeGreaterThan(0);
  });

  test("validates fully populated input and returns the normalized record", async () => {
    const schema = await loadTemplate("handover");
    const input = {
      id: "HANDOVER-0001",
      project: "wiki-v2",
      session_date: "2026-05-25",
      phase: "red",
      next_phase: "green",
      active_prd: "PRD-001",
      active_slices: ["SLICE-001"],
      decisions_made: ["ADR-0001"],
      suggested_skills: ["/wiki", "/tdd"],
      status: "open",
      created: "2026-05-25",
    };

    expect(validate(schema, input)).toEqual({ ok: true, value: input });
  });

  test("rejects input missing a required field with the field name", async () => {
    const schema = await loadTemplate("prd");

    expect(validate(schema, { id: "PRD-001", project: "wiki-v2", status: "draft" })).toEqual({
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

    expect(validate(schema, { id: "PRD-001", title: "Tiny", project: "wiki-v2", status: "draft" })).toEqual({
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
});
