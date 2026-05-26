import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  ensureObsidian,
  isObsidianRunning,
  obsidianAppend,
  obsidianCommand,
  obsidianCreate,
  obsidianEval,
  obsidianPluginEnable,
  obsidianPluginInstall,
  obsidianPropertyRead,
  obsidianPropertySet,
  obsidianRead,
  obsidianSearch,
  ObsidianError,
  ObsidianNotRunningError,
} from "../src/integrations/obsidian";

const MOCK_BIN = join(import.meta.dir, "fixtures", "mock-obsidian.sh");

beforeAll(() => {
  process.env.OBSIDIAN_BIN = MOCK_BIN;
});

afterAll(() => {
  delete process.env.OBSIDIAN_BIN;
});

describe("ensureObsidian", () => {
  test("succeeds when obsidian version returns cleanly", async () => {
    await expect(ensureObsidian()).resolves.toBeUndefined();
  });

  test("throws ObsidianNotRunningError when binary is missing", async () => {
    const prev = process.env.OBSIDIAN_BIN;
    process.env.OBSIDIAN_BIN = "/nonexistent/obsidian";
    try {
      await expect(ensureObsidian()).rejects.toThrow(ObsidianNotRunningError);
    } finally {
      process.env.OBSIDIAN_BIN = prev;
    }
  });
});

describe("isObsidianRunning", () => {
  test("returns true when mock is available", async () => {
    expect(await isObsidianRunning()).toBe(true);
  });

  test("returns false when binary is missing", async () => {
    const prev = process.env.OBSIDIAN_BIN;
    process.env.OBSIDIAN_BIN = "/nonexistent/obsidian";
    try {
      expect(await isObsidianRunning()).toBe(false);
    } finally {
      process.env.OBSIDIAN_BIN = prev;
    }
  });
});

describe("obsidianCreate", () => {
  test("builds correct command and returns created file path", async () => {
    const result = await obsidianCreate("my-note", "Some content", "notes");
    expect(result).toBe("notes/my-note.md");
  });

  test("passes silent and overwrite options", async () => {
    const result = await obsidianCreate("my-note", "Content", "notes", {
      silent: true,
      overwrite: true,
    });
    expect(result).toBe("notes/my-note.md");
  });
});

describe("obsidianRead", () => {
  test("returns file content", async () => {
    const result = await obsidianRead("notes/test.md");
    expect(result).toContain("# Mock Content");
    expect(result).toContain("title: Mock Note");
  });
});

describe("obsidianAppend", () => {
  test("completes without error", async () => {
    await expect(obsidianAppend("notes/test.md", "new content")).resolves.toBeUndefined();
  });
});

describe("obsidianPropertySet", () => {
  test("sets a property", async () => {
    await expect(
      obsidianPropertySet("notes/test.md", "status", "accepted"),
    ).resolves.toBeUndefined();
  });

  test("passes type parameter when provided", async () => {
    await expect(
      obsidianPropertySet("notes/test.md", "status", "accepted", "text"),
    ).resolves.toBeUndefined();
  });
});

describe("obsidianPropertyRead", () => {
  test("returns the property value", async () => {
    const result = await obsidianPropertyRead("notes/test.md", "status");
    expect(result).toBe("accepted");
  });
});

describe("obsidianSearch", () => {
  test("returns search results", async () => {
    const result = await obsidianSearch("test query");
    expect(result).toContain("test.md");
  });

  test("passes limit and format options", async () => {
    const result = await obsidianSearch("test query", { limit: 5, format: "json" });
    expect(result).toContain("test.md");
  });
});

describe("obsidianEval", () => {
  test("strips the => prefix from output", async () => {
    const result = await obsidianEval("1 + 1");
    expect(result).toBe("42");
  });
});

describe("obsidianPluginInstall", () => {
  test("completes without error", async () => {
    await expect(obsidianPluginInstall("dataview")).resolves.toBeUndefined();
  });
});

describe("obsidianPluginEnable", () => {
  test("completes without error", async () => {
    await expect(obsidianPluginEnable("dataview")).resolves.toBeUndefined();
  });
});

describe("obsidianCommand", () => {
  test("completes without error", async () => {
    await expect(obsidianCommand("app:reload")).resolves.toBeUndefined();
  });
});

describe("error detection", () => {
  test("obsidianCreate throws ObsidianError when output contains Error:", async () => {
    // Create a temporary script that outputs an error
    const errorScript = join(import.meta.dir, "fixtures", "mock-obsidian-error.sh");
    await Bun.write(errorScript, '#!/bin/bash\necho "Error: vault not found"\n');
    const { chmod } = await import("node:fs/promises");
    await chmod(errorScript, 0o755);

    const prev = process.env.OBSIDIAN_BIN;
    process.env.OBSIDIAN_BIN = errorScript;
    try {
      await expect(obsidianCreate("test", "content", "notes")).rejects.toThrow(ObsidianError);
    } finally {
      process.env.OBSIDIAN_BIN = prev;
      const { unlink } = await import("node:fs/promises");
      await unlink(errorScript).catch(() => {});
    }
  });
});
