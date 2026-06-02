import { describe, expect, test } from "bun:test";

import { dispatch } from "../src/cli/dispatch";
import { USAGE_REGISTRY } from "../src/cli/usage";

/**
 * Regression guard for ADR-0023: USAGE_REGISTRY is the authoritative command
 * surface, so anything it advertises must be reachable in the handlers and
 * nothing it advertises may be a flag/arg the handler rejects. These cases each
 * lock a drift the audit caught where help promised something the CLI refused.
 */

function capture(): { restore: () => void; out: () => string } {
  const log = console.log;
  const err = console.error;
  let buffer = "";
  const sink = (...args: unknown[]) => {
    buffer += args.map(String).join(" ") + "\n";
  };
  console.log = sink;
  console.error = sink;
  return {
    restore: () => {
      console.log = log;
      console.error = err;
    },
    out: () => buffer,
  };
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cap = capture();
  let code = 0;
  try {
    code = (await dispatch(args)).code;
  } finally {
    cap.restore();
  }
  return { code, out: cap.out() };
}

describe("registry ↔ handler contract (ADR-0023)", () => {
  test("create models every dispatched artifact form as a subverb", () => {
    // Mirrors the branches in handleCreate; if a form is added there it must be
    // advertised here so `wiki create <form> --help` and the unknown-type error stay truthful.
    const dispatched = ["prd", "slice", "decision", "doc", "handover"].sort();
    const advertised = Object.keys(USAGE_REGISTRY.create?.subverbs ?? {}).sort();
    expect(advertised).toEqual(dispatched);
  });

  test("every create subverb has per-form --help with its required flags", async () => {
    for (const sub of Object.keys(USAGE_REGISTRY.create?.subverbs ?? {})) {
      const { code, out } = await run(["create", sub, "--help"]);
      expect(code, `create ${sub} --help should exit 0`).toBe(0);
      expect(out, `create ${sub} --help should show usage`).toContain(`wiki create ${sub}`);
    }
    // The specific gap the audit found: slice help must surface --parent-prd.
    const slice = await run(["create", "slice", "--help"]);
    expect(slice.out).toContain("--parent-prd");
  });

  test("unknown artifact type lists exactly the advertised forms (no hardcoded drift)", async () => {
    const { code, out } = await run(["create", "bogus"]);
    expect(code).toBe(1);
    expect(out).toContain("unknown artifact type: bogus");
    for (const sub of Object.keys(USAGE_REGISTRY.create?.subverbs ?? {})) {
      expect(out, `valid set should include ${sub}`).toContain(sub);
    }
  });

  test("an unknown subverb is rejected (proves the valid set is real, not advisory)", async () => {
    const { code, out } = await run(["project", "definitely-not-a-subverb"]);
    expect(code).toBe(1);
    expect(out).toContain("unknown project subverb");
  });

  test("handover help does not advertise --title (the handler never parses it)", () => {
    const flags = USAGE_REGISTRY.handover?.flags ?? {};
    expect(Object.keys(flags)).not.toContain("--title");
    const createHandover = USAGE_REGISTRY.create?.subverbs?.handover?.flags ?? {};
    expect(Object.keys(createHandover)).not.toContain("--title");
  });

  test("sync help advertises --project, matching the handler's required field", () => {
    expect(USAGE_REGISTRY.sync?.usage).toContain("--project");
    expect(Object.keys(USAGE_REGISTRY.sync?.flags ?? {})).toContain("--project");
  });

  test("vault sync help advertises the required <path> argument", () => {
    expect(USAGE_REGISTRY.vault?.subverbs?.sync?.usage).toContain("<path>");
  });

  test("next-id advertises doc, matching the handler's accepted types", () => {
    expect(USAGE_REGISTRY["next-id"]?.usage).toContain("doc");
  });

  test("create help marks --project as session-defaulted, not unconditionally required", () => {
    // create prd/slice/decision/doc now default --project from the repo session
    // (resolveProject); help must not keep telling agents it is always required.
    for (const form of ["prd", "slice", "decision", "doc"] as const) {
      const project = USAGE_REGISTRY.create?.subverbs?.[form]?.flags?.["--project"] ?? "";
      expect(project, `${form} --project help`).toContain("if no active session");
    }
  });
});
