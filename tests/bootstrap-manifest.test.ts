import { describe, expect, test } from "bun:test";

import {
  loadPluginManifest,
  requiredPlugins,
  loadDefaultConfig,
} from "../src/bootstrap/manifest";
import type { PluginManifest } from "../src/bootstrap/manifest";

describe("plugin manifest", () => {
  let manifest: PluginManifest;

  test("loadPluginManifest returns all 6 plugins", async () => {
    manifest = await loadPluginManifest();
    expect(manifest.plugins).toHaveLength(6);
  });

  test("every plugin entry has id, repo, and required fields", async () => {
    manifest = await loadPluginManifest();
    for (const plugin of manifest.plugins) {
      expect(typeof plugin.id).toBe("string");
      expect(plugin.id.length).toBeGreaterThan(0);
      expect(typeof plugin.repo).toBe("string");
      expect(plugin.repo).toContain("/");
      expect(typeof plugin.required).toBe("boolean");
      expect(typeof plugin.defaultConfigPath).toBe("string");
    }
  });

  test("requiredPlugins returns exactly 4 required plugins", async () => {
    manifest = await loadPluginManifest();
    const required = requiredPlugins(manifest);
    expect(required).toHaveLength(4);
    expect(required.every((p) => p.required)).toBe(true);

    const ids = required.map((p) => p.id).sort();
    expect(ids).toEqual([
      "dataview",
      "obsidian-git",
      "obsidian-linter",
      "templater-obsidian",
    ]);
  });

  test("each required plugin has a non-empty defaultConfigPath that resolves to a readable file", async () => {
    manifest = await loadPluginManifest();
    const required = requiredPlugins(manifest);

    for (const entry of required) {
      expect(entry.defaultConfigPath.length).toBeGreaterThan(0);
      const config = await loadDefaultConfig(entry);
      expect(typeof config).toBe("object");
      expect(config).not.toBeNull();
    }
  });

  test("loadDefaultConfig returns parsed JSON with expected keys for each required plugin", async () => {
    manifest = await loadPluginManifest();
    const required = requiredPlugins(manifest);

    const expectations: Record<string, string[]> = {
      dataview: ["refreshEnabled", "renderNullAs"],
      "templater-obsidian": ["template_folder", "trigger_on_file_creation"],
      "obsidian-linter": ["ruleConfigs"],
      "obsidian-git": ["autoSaveInterval", "autoPullInterval"],
    };

    for (const entry of required) {
      const config = await loadDefaultConfig(entry);
      const expectedKeys = expectations[entry.id];
      expect(expectedKeys).toBeDefined();
      if (expectedKeys) {
        for (const key of expectedKeys) {
          expect(config).toHaveProperty(key);
        }
      }
    }
  });

});
