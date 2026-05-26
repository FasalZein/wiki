import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blessPlugin, resetPlugin } from "../src/bootstrap/bless";
import {
  loadPluginManifest,
  loadDefaultConfig,
  requiredPlugins,
} from "../src/bootstrap/manifest";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function makeTempVault(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "wiki-bless-"));
  tempPaths.push(base);
  const vault = join(base, "vault");
  await mkdir(join(vault, ".obsidian", "plugins"), { recursive: true });
  await mkdir(join(vault, ".wiki", "blessed-config"), { recursive: true });
  return vault;
}

const SAMPLE_CONFIG = { setting: "custom", enabled: true, count: 42 };
const PLUGIN_ID = "dataview";

describe("blessPlugin", () => {
  test("copies data.json to blessed-config/", async () => {
    const vault = await makeTempVault();
    const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "data.json"),
      JSON.stringify(SAMPLE_CONFIG, null, 2) + "\n",
    );

    const result = await blessPlugin(vault, PLUGIN_ID);

    expect(result.status).toBe("blessed");
    expect(result.plugin).toBe(PLUGIN_ID);

    const blessedPath = join(vault, ".wiki", "blessed-config", `${PLUGIN_ID}.json`);
    const raw = await readFile(blessedPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(SAMPLE_CONFIG);
  });

  test('returns "no-config" when plugin has no data.json', async () => {
    const vault = await makeTempVault();
    // Create plugin dir but no data.json
    await mkdir(join(vault, ".obsidian", "plugins", PLUGIN_ID), {
      recursive: true,
    });

    const result = await blessPlugin(vault, PLUGIN_ID);

    expect(result.status).toBe("no-config");
    expect(result.plugin).toBe(PLUGIN_ID);
  });

  test('returns "not-found" when plugin dir does not exist', async () => {
    const vault = await makeTempVault();

    const result = await blessPlugin(vault, "nonexistent-plugin");

    expect(result.status).toBe("not-found");
    expect(result.plugin).toBe("nonexistent-plugin");
  });

  test("blessed config content matches original data.json", async () => {
    const vault = await makeTempVault();
    const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });

    const original = { complex: { nested: true }, list: [1, 2, 3] };
    await writeFile(
      join(pluginDir, "data.json"),
      JSON.stringify(original, null, 2) + "\n",
    );

    await blessPlugin(vault, PLUGIN_ID);

    const blessedPath = join(vault, ".wiki", "blessed-config", `${PLUGIN_ID}.json`);
    const raw = await readFile(blessedPath, "utf8");
    expect(raw).toBe(JSON.stringify(original, null, 2) + "\n");
  });
});

describe("resetPlugin", () => {
  test("copies blessed config to data.json", async () => {
    const vault = await makeTempVault();
    const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });

    // Write a blessed config
    const blessedContent = { blessed: true, marker: "team-default" };
    await writeFile(
      join(vault, ".wiki", "blessed-config", `${PLUGIN_ID}.json`),
      JSON.stringify(blessedContent, null, 2) + "\n",
    );

    // Write some divergent data.json
    await writeFile(
      join(pluginDir, "data.json"),
      JSON.stringify({ diverged: true }, null, 2) + "\n",
    );

    const result = await resetPlugin(vault, PLUGIN_ID);

    expect(result.status).toBe("reset");
    expect(result.plugin).toBe(PLUGIN_ID);
    expect(result.source).toBe("blessed");

    const raw = await readFile(join(pluginDir, "data.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(blessedContent);
  });

  test("falls back to CLI default when no blessed config exists", async () => {
    const vault = await makeTempVault();
    const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });

    // Write some divergent data.json (no blessed config)
    await writeFile(
      join(pluginDir, "data.json"),
      JSON.stringify({ diverged: true }, null, 2) + "\n",
    );

    const result = await resetPlugin(vault, PLUGIN_ID);

    expect(result.status).toBe("reset");
    expect(result.plugin).toBe(PLUGIN_ID);
    expect(result.source).toBe("default");

    // Verify it matches the CLI-bundled default
    const manifest = await loadPluginManifest();
    const entry = requiredPlugins(manifest).find((p) => p.id === PLUGIN_ID);
    expect(entry).toBeDefined();

    const expectedDefault = await loadDefaultConfig(entry!);
    const raw = await readFile(join(pluginDir, "data.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(expectedDefault);
  });

  test('returns "no-blessed-or-default" when neither exists', async () => {
    const vault = await makeTempVault();
    const pluginDir = join(
      vault,
      ".obsidian",
      "plugins",
      "obsidian-tasks-plugin",
    );
    await mkdir(pluginDir, { recursive: true });

    // optional plugin with no defaultConfigPath and no blessed
    const result = await resetPlugin(vault, "obsidian-tasks-plugin");

    expect(result.status).toBe("no-blessed-or-default");
    expect(result.plugin).toBe("obsidian-tasks-plugin");
  });

  test('source is "blessed" when blessed config is used', async () => {
    const vault = await makeTempVault();
    const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "data.json"),
      JSON.stringify({}, null, 2) + "\n",
    );

    await writeFile(
      join(vault, ".wiki", "blessed-config", `${PLUGIN_ID}.json`),
      JSON.stringify({ from: "blessed" }, null, 2) + "\n",
    );

    const result = await resetPlugin(vault, PLUGIN_ID);
    expect(result.source).toBe("blessed");
  });

  test('source is "default" when CLI default is used', async () => {
    const vault = await makeTempVault();
    const pluginDir = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "data.json"),
      JSON.stringify({}, null, 2) + "\n",
    );

    // No blessed config, so should fall back to CLI default
    const result = await resetPlugin(vault, PLUGIN_ID);
    expect(result.source).toBe("default");
  });
});
