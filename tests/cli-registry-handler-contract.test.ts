import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";
import { dispatch } from "../src/cli/dispatch";
import { USAGE_REGISTRY } from "../src/cli/usage";

const ARTIFACTS = DEFAULT_STRUCTURE.kinds;

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
  test("every advertised create subverb is a real kind in wiki.json (config-driven dispatch)", () => {
    // ADR-0035: handleCreate dispatches every kind in ARTIFACTS (wiki.json), not a
    // hardcoded union. USAGE_REGISTRY curates per-form help for a *subset* of those
    // kinds (handoff has none, relying on generic help + `wiki schema`), so the
    // contract is a subset check: every curated subverb must name a real kind.
    const kinds = Object.keys(ARTIFACTS);
    for (const sub of Object.keys(USAGE_REGISTRY.create?.subverbs ?? {})) {
      expect(kinds, `advertised subverb ${sub} must be a kind in wiki.json`).toContain(sub);
    }
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

  test("unknown artifact type lists exactly the kinds defined in wiki.json (no hardcoded drift)", async () => {
    // Hermetic: point at a vault with no wiki.json so loadStructure falls back to
    // DEFAULT_STRUCTURE deterministically. Without this the test inherits the
    // developer's ambient ~/.config/wiki vault, whose custom wiki.json kinds
    // (correctly) differ from the bundled default — the error now reflects the
    // *configured* vault's kinds (BUG-4 fix, NOTE-0007), not a hardcoded set.
    const emptyVault = await mkdtemp(join(tmpdir(), "wiki-default-struct-"));
    const prev = process.env.KNOWLEDGE_VAULT_ROOT;
    process.env.KNOWLEDGE_VAULT_ROOT = emptyVault;
    try {
      const { code, out } = await run(["create", "bogus"]);
      expect(code).toBe(1);
      expect(out).toContain("unknown artifact type: bogus");
      for (const kind of Object.keys(ARTIFACTS)) {
        expect(out, `valid set should include ${kind}`).toContain(kind);
      }
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
      else process.env.KNOWLEDGE_VAULT_ROOT = prev;
      await rm(emptyVault, { recursive: true, force: true });
    }
  });

  test("an unknown subverb is rejected (proves the valid set is real, not advisory)", async () => {
    const { code, out } = await run(["project", "definitely-not-a-subverb"]);
    expect(code).toBe(1);
    expect(out).toContain("unknown project subverb");
  });

  test("sync help advertises --project, matching the handler's required field", () => {
    expect(USAGE_REGISTRY.sync?.usage).toContain("--project");
    expect(Object.keys(USAGE_REGISTRY.sync?.flags ?? {})).toContain("--project");
  });

  test("next-id advertises the promoted kinds, matching the handler's accepted types", () => {
    expect(USAGE_REGISTRY["next-id"]?.usage).toContain("research");
  });

  test("create help marks --project as link-defaulted, not unconditionally required", () => {
    // create prd/slice/decision now default --project from the repo's linked
    // project (resolveProject); help must not keep telling agents it is always required.
    for (const form of ["prd", "slice", "decision"] as const) {
      const project = USAGE_REGISTRY.create?.subverbs?.[form]?.flags?.["--project"] ?? "";
      expect(project, `${form} --project help`).toContain("if the repo isn't linked");
    }
  });
});
