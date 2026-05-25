import { describe, expect, test } from "bun:test";

import { loadTemplate } from "../src/schema/load";

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
});
