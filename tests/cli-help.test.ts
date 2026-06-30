import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      "validate", "next-id", "doctor", "sync", "vault", "project",
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
    for (const verb of ["vault", "project", "doc"]) {
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

describe("dynamic kind list in help", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempPaths: string[];

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempPaths = [];
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true })));
  });

  test("create --help lists the vault's 10 kinds when a vault is configured", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-help-"));
    tempPaths.push(vaultRoot);
    await mkdir(join(vaultRoot, "projects"), { recursive: true });
    const wikiJson = {
      kinds: {
        prd: { prefix: "PRD", folder: "prds" },
        slice: { prefix: "SLICE", folder: "slices" },
        decision: { prefix: "ADR", folder: "adrs" },
        architecture: { prefix: "ARCH", folder: "architecture" },
        research: { prefix: "RES", folder: "research" },
        runbooks: { prefix: "RUN", folder: "runbooks" },
        specs: { prefix: "SPEC", folder: "specs" },
        notes: { prefix: "NOTE", folder: "notes" },
        legacy: { prefix: "LEG", folder: "legacy" },
        handoff: { prefix: "HANDOFF", folder: "handoffs" },
      },
    };
    await writeFile(join(vaultRoot, "wiki.json"), JSON.stringify(wikiJson));
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    const cap = captureStdout();
    const result = await dispatch(["create", "--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    const output = cap.output();
    for (const kind of Object.keys(wikiJson.kinds)) {
      expect(output, `should list kind: ${kind}`).toContain(kind);
    }
  });

  test("next-id --help lists the vault's kinds in the usage placeholder", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-help-"));
    tempPaths.push(vaultRoot);
    await mkdir(join(vaultRoot, "projects"), { recursive: true });
    const wikiJson = {
      kinds: {
        prd: { prefix: "PRD", folder: "prds" },
        slice: { prefix: "SLICE", folder: "slices" },
        decision: { prefix: "ADR", folder: "adrs" },
        architecture: { prefix: "ARCH", folder: "architecture" },
        research: { prefix: "RES", folder: "research" },
        runbooks: { prefix: "RUN", folder: "runbooks" },
        specs: { prefix: "SPEC", folder: "specs" },
        notes: { prefix: "NOTE", folder: "notes" },
        legacy: { prefix: "LEG", folder: "legacy" },
        handoff: { prefix: "HANDOFF", folder: "handoffs" },
      },
    };
    await writeFile(join(vaultRoot, "wiki.json"), JSON.stringify(wikiJson));
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    const cap = captureStdout();
    const result = await dispatch(["next-id", "--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    const output = cap.output();
    expect(output).toContain("<prd|slice|decision|architecture|research|runbooks|specs|notes|legacy|handoff>");
  });

  test("create --help falls back to default 5 kinds when no vault is configured", async () => {
    // Point at a non-existent path so getVaultRoot throws
    const home = await mkdtemp(join(tmpdir(), "wiki-help-"));
    tempPaths.push(home);
    process.env.HOME = home;
    delete process.env.KNOWLEDGE_VAULT_ROOT;

    const cap = captureStdout();
    const result = await dispatch(["create", "--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    const output = cap.output();
    // Default 5 kinds
    for (const kind of ["prd", "slice", "decision", "doc", "handoff"]) {
      expect(output, `should list default kind: ${kind}`).toContain(kind);
    }
    // Should NOT list promoted kinds that only exist in a configured vault
    expect(output).not.toContain("architecture");
    expect(output).not.toContain("runbooks");
  });

  test("next-id --help falls back to default 5 kinds when no vault is configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-help-"));
    tempPaths.push(home);
    process.env.HOME = home;
    delete process.env.KNOWLEDGE_VAULT_ROOT;

    const cap = captureStdout();
    const result = await dispatch(["next-id", "--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    const output = cap.output();
    expect(output).toContain("<prd|slice|decision|doc|handoff>");
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
    for (const verb of ["create", "status", "search", "doc", "vault", "project"]) {
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
      ["vault", "init"], ["project", "create"], ["doc", "retitle"],
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
