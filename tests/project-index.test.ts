import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectIndex, resolveQmdCommand, resolveSharedQmdCommand } from "../src/integrations/project-index";

// The preload pins QMD_COMMAND to the noop fake; these tests drive the resolution
// precedence directly, so save and restore it around each case.
const savedEnv = process.env.QMD_COMMAND;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.QMD_COMMAND;
  else process.env.QMD_COMMAND = savedEnv;
});

describe("resolveQmdCommand precedence", () => {
  test("env beats config", () => {
    process.env.QMD_COMMAND = "ENV_QMD";
    expect(resolveQmdCommand({ qmd_command: "CONFIG_QMD" })).toBe("ENV_QMD");
  });

  test("config beats default when no env", () => {
    delete process.env.QMD_COMMAND;
    expect(resolveQmdCommand({ qmd_command: "CONFIG_QMD" })).toBe("CONFIG_QMD");
  });

  test("default qmd when neither env nor config", () => {
    delete process.env.QMD_COMMAND;
    expect(resolveQmdCommand()).toBe("qmd");
  });
});

describe("resolveSharedQmdCommand (vault-wide)", () => {
  test("env pins the command regardless of config divergence", () => {
    process.env.QMD_COMMAND = "ENV_QMD";
    const result = resolveSharedQmdCommand([
      ["a", { qmd_command: "x" }],
      ["b", { qmd_command: "y" }],
    ]);
    expect(result).toEqual({ command: "ENV_QMD" });
  });

  test("agreeing configs resolve to their shared command", () => {
    delete process.env.QMD_COMMAND;
    const result = resolveSharedQmdCommand([
      ["a", { qmd_command: "qmd" }],
      ["b", { qmd_command: "qmd" }],
    ]);
    expect(result).toEqual({ command: "qmd" });
  });

  test("diverging configs report the value→project pairs", () => {
    delete process.env.QMD_COMMAND;
    const result = resolveSharedQmdCommand([
      ["a", { qmd_command: "x" }],
      ["b", { qmd_command: "y" }],
    ]);
    expect(result).toEqual({ divergent: [["a", "x"], ["b", "y"]] });
  });
});

describe("projectIndex", () => {
  test("resolves the command once at construction (no re-resolution)", () => {
    delete process.env.QMD_COMMAND;
    const index = projectIndex({ project: "p", projectPath: "/tmp/p", config: { qmd_command: "FIRST" } });
    expect(index.command).toBe("FIRST");
    // Later env changes must not re-resolve a live object.
    process.env.QMD_COMMAND = "SECOND";
    expect(index.command).toBe("FIRST");
  });

  test("sequences refresh before query through the qmd adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "project-index-"));
    try {
      const log = join(dir, "calls.log");
      const script = join(dir, "fake-qmd.sh");
      await writeFile(
        script,
        `#!/usr/bin/env bash\nset -euo pipefail\necho "$@" >> "${log}"\ncase "\${1:-}" in\n  query) echo '[]' ;;\n  *) : ;;\nesac\n`,
      );
      await chmod(script, 0o755);
      process.env.QMD_COMMAND = script;

      const index = projectIndex({ project: "proj", projectPath: dir });
      await index.ensure();
      await index.refresh();
      await index.query("hello");

      const lines = (await readFile(log, "utf8")).trim().split("\n");
      const firstUpdate = lines.findIndex((l) => l.startsWith("update"));
      const firstQuery = lines.findIndex((l) => l.startsWith("query"));
      expect(firstUpdate).toBeGreaterThanOrEqual(0);
      expect(firstQuery).toBeGreaterThanOrEqual(0);
      expect(firstUpdate).toBeLessThan(firstQuery);
      // ensure() registered the collection before either.
      expect(lines[0]?.startsWith("collection")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
