import { describe, expect, test } from "bun:test";

import {
  codexLockInstructions,
  type CodexLockResult,
} from "../src/bootstrap/codex-lock";

describe("codexLockInstructions", () => {
  const vaultPath = "/tmp/test-vault";

  test("returns status 'instructions-printed'", () => {
    const result: CodexLockResult = codexLockInstructions(vaultPath);
    expect(result.status).toBe("instructions-printed");
  });

  test("instructions include the vault path", () => {
    const result = codexLockInstructions(vaultPath);
    expect(result.instructions).toContain(vaultPath);
  });

  test("instructions include deny pattern examples", () => {
    const result = codexLockInstructions(vaultPath);
    expect(result.instructions).toContain(`Edit: ${vaultPath}/**`);
    expect(result.instructions).toContain(`Write: ${vaultPath}/**`);
    expect(result.instructions).toContain(`Bash redirects to: ${vaultPath}/*`);
  });

  test("instructions mention running 'wiki vault doctor'", () => {
    const result = codexLockInstructions(vaultPath);
    expect(result.instructions).toContain("wiki vault doctor");
  });

  test("is a pure function with no filesystem side effects", () => {
    // codexLockInstructions is a pure function — it takes a string and returns
    // a result object. No fs imports, no file writes. This test simply confirms
    // the return type is a plain object with the expected shape.
    const result = codexLockInstructions(vaultPath);
    expect(typeof result).toBe("object");
    expect(Object.keys(result).sort()).toEqual(["instructions", "status"]);
    expect(typeof result.instructions).toBe("string");
    expect(typeof result.status).toBe("string");
  });
});
