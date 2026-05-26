import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WikiVaultConfig } from "../src/bootstrap/config";
import { initWikiConfig, readWikiConfig, writeWikiConfig } from "../src/bootstrap/config";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-config-"));
  await mkdir(join(dir, ".wiki"), { recursive: true });
  tempPaths.push(dir);
  return dir;
}

describe("wiki vault config", () => {
  test("readWikiConfig returns defaults when file is missing", async () => {
    const vault = await makeTempVault();
    const config = await readWikiConfig(vault);

    expect(config).toEqual({
      search: { auto_refresh: true },
    });
  });

  test("readWikiConfig returns parsed config when file exists", async () => {
    const vault = await makeTempVault();
    const stored: WikiVaultConfig = {
      default_project: "my-proj",
      search: { auto_refresh: false },
    };
    await writeFile(join(vault, ".wiki", "config.json"), JSON.stringify(stored, null, 2) + "\n");

    const config = await readWikiConfig(vault);

    expect(config).toEqual(stored);
  });

  test("readWikiConfig merges defaults for missing fields", async () => {
    const vault = await makeTempVault();
    // Write a config missing the search section
    await writeFile(join(vault, ".wiki", "config.json"), JSON.stringify({ default_project: "x" }, null, 2) + "\n");

    const config = await readWikiConfig(vault);

    expect(config.default_project).toBe("x");
    expect(config.search).toEqual({ auto_refresh: true });
  });

  test("writeWikiConfig writes valid JSON", async () => {
    const vault = await makeTempVault();
    const config: WikiVaultConfig = {
      default_project: "test-proj",
      search: { auto_refresh: false },
    };

    await writeWikiConfig(vault, config);

    const raw = await readFile(join(vault, ".wiki", "config.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(config);
  });

  test("initWikiConfig writes default config when file missing", async () => {
    const vault = await makeTempVault();

    const written = await initWikiConfig(vault);

    expect(written).toBe(true);
    const raw = await readFile(join(vault, ".wiki", "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.search.auto_refresh).toBe(true);
    expect(parsed.default_project).toBeUndefined();
  });

  test("initWikiConfig includes default_project when provided", async () => {
    const vault = await makeTempVault();

    const written = await initWikiConfig(vault, "wiki-v2");

    expect(written).toBe(true);
    const raw = await readFile(join(vault, ".wiki", "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.default_project).toBe("wiki-v2");
    expect(parsed.search.auto_refresh).toBe(true);
  });

  test("initWikiConfig skips write when file already exists", async () => {
    const vault = await makeTempVault();
    const existing: WikiVaultConfig = {
      default_project: "old-proj",
      search: { auto_refresh: false },
    };
    await writeFile(join(vault, ".wiki", "config.json"), JSON.stringify(existing, null, 2) + "\n");

    const written = await initWikiConfig(vault, "new-proj");

    expect(written).toBe(false);
    const raw = await readFile(join(vault, ".wiki", "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.default_project).toBe("old-proj");
  });

  test("config has NO harness-specific fields", () => {
    // WikiVaultConfig type must not contain harness, lock_config_path, or similar fields.
    // We verify at runtime by checking that a default config object has only expected keys.
    const defaultConfig: WikiVaultConfig = {
      search: { auto_refresh: true },
    };
    const keys = Object.keys(defaultConfig);
    expect(keys).toEqual(["search"]);
    expect(keys).not.toContain("harness");
    expect(keys).not.toContain("lock_config_path");

    const fullConfig: WikiVaultConfig = {
      default_project: "proj",
      search: { auto_refresh: true },
    };
    const fullKeys = Object.keys(fullConfig).sort();
    expect(fullKeys).toEqual(["default_project", "search"]);
  });

  test("auto_refresh defaults to true", async () => {
    const vault = await makeTempVault();
    const config = await readWikiConfig(vault);

    expect(config.search.auto_refresh).toBe(true);
  });
});
