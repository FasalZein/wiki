import { describe, expect, test } from "bun:test";

import { loadTemplate } from "../src/schema/load";
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
      decisions_made: ["DECISION-0001"],
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
});
