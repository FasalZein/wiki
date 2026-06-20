import { describe, expect, test } from "bun:test";

import { dispatch } from "../src/cli/dispatch";
import { USAGE_REGISTRY, renderHelp, type UsageEntry } from "../src/cli/usage";

function captureStdout(): { restore: () => void; output: () => string } {
  const original = console.log;
  let buffer = "";
  console.log = (...args: unknown[]) => {
    buffer += args.map(String).join(" ") + "\n";
  };
  return { restore: () => { console.log = original; }, output: () => buffer };
}

describe("usage registry", () => {
  test("every top-level verb has a usage entry with summary and example", () => {
    const verbs = [
      "create", "doc", "status", "search",
      "validate", "next-id", "doctor", "sync", "session", "vault", "project",
    ];
    for (const verb of verbs) {
      const entry = USAGE_REGISTRY[verb];
      expect(entry, `missing usage entry for verb: ${verb}`).toBeDefined();
      if (entry === undefined) continue;
      expect(entry.summary.length, `empty summary for ${verb}`).toBeGreaterThan(0);
      expect(entry.example.length, `missing example for ${verb}`).toBeGreaterThan(0);
    }
  });

  test("subverb-bearing verbs declare their subverbs", () => {
    for (const verb of ["session", "vault", "project", "doc"]) {
      const entry = USAGE_REGISTRY[verb];
      expect(entry?.subverbs, `${verb} should declare subverbs`).toBeDefined();
      expect(Object.keys(entry?.subverbs ?? {}).length).toBeGreaterThan(0);
    }
  });

  test("renderHelp produces usage, the summary, and an example", () => {
    const entry: UsageEntry = {
      summary: "Do the thing",
      usage: "wiki thing <id> --flag <v>",
      flags: { "--flag": "the flag" },
      example: "wiki thing ABC-1 --flag x",
    };
    const text = renderHelp("thing", entry);
    expect(text).toContain("Do the thing");
    expect(text).toContain("usage:");
    expect(text).toContain("wiki thing");
    expect(text).toContain("--flag");
    expect(text).toContain("Example:");
  });
});

describe("--help dispatch", () => {
  test("bare wiki lists all verbs and exits 0", async () => {
    const cap = captureStdout();
    const result = await dispatch([]);
    cap.restore();
    expect(result.code).toBe(0);
    expect(cap.output()).toContain("create");
    expect(cap.output()).toContain("search");
  });

  test("wiki --help lists all verbs and exits 0", async () => {
    const cap = captureStdout();
    const result = await dispatch(["--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    expect(cap.output()).toContain("status");
  });

  test("wiki <verb> --help prints that verb's usage and exits 0", async () => {
    for (const verb of ["create", "status", "search", "doc", "session", "vault", "project"]) {
      const cap = captureStdout();
      const result = await dispatch([verb, "--help"]);
      cap.restore();
      expect(result.code, `${verb} --help should exit 0`).toBe(0);
      expect(cap.output(), `${verb} --help should print usage`).toContain("usage:");
    }
  });

  test("wiki status --help does not crash the positional parser", async () => {
    const cap = captureStdout();
    const result = await dispatch(["status", "--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    expect(cap.output()).toContain("status");
  });

  test("wiki <verb> <subverb> --help prints subverb usage and exits 0", async () => {
    const cases: [string, string][] = [
      ["session", "start"], ["vault", "init"], ["project", "create"], ["doc", "retitle"],
    ];
    for (const [verb, subverb] of cases) {
      const cap = captureStdout();
      const result = await dispatch([verb, subverb, "--help"]);
      cap.restore();
      expect(result.code, `${verb} ${subverb} --help should exit 0`).toBe(0);
      expect(cap.output(), `${verb} ${subverb} --help should print usage`).toContain("usage:");
    }
  });

  test("-h is an alias for --help", async () => {
    const cap = captureStdout();
    const result = await dispatch(["create", "-h"]);
    cap.restore();
    expect(result.code).toBe(0);
    expect(cap.output()).toContain("usage:");
  });
});
