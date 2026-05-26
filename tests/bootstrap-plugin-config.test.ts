import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePluginConfigs } from "../src/bootstrap/plugin-config";
import {
  loadPluginManifest,
  requiredPlugins,
  loadDefaultConfig,
} from "../src/bootstrap/manifest";
import type { PluginManifest } from "../src/bootstrap/manifest";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

async function makeTempVault(manifest: PluginManifest): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "wiki-plugin-config-"));
  tempPaths.push(base);
  const vault = join(base, "vault");

  // Create plugin dirs for all required plugins (simulates installed plugins)
  const required = requiredPlugins(manifest);
  for (const p of required) {
    await mkdir(join(vault, ".obsidian", "plugins", p.id), { recursive: true });
  }

  // Create blessed-config dir
  await mkdir(join(vault, ".wiki", "blessed-config"), { recursive: true });

  return vault;
}

describe("plugin config", () => {
  let manifest: PluginManifest;

  test("writes default config for plugins without data.json", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    const result = await writePluginConfigs(vault, manifest);

    const required = requiredPlugins(manifest);
    for (const p of required) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      const raw = await readFile(dataPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    }

    expect(result.written.sort()).toEqual(required.map((p) => p.id).sort());
    expect(result.skipped).toHaveLength(0);
  });

  test("skips plugins that already have data.json", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    const required = requiredPlugins(manifest);
    // Pre-write data.json for all plugins
    for (const p of required) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      await writeFile(dataPath, JSON.stringify({ existing: true }, null, 2) + "\n");
    }

    const result = await writePluginConfigs(vault, manifest);

    expect(result.skipped.sort()).toEqual(required.map((p) => p.id).sort());
    expect(result.written).toHaveLength(0);

    // Verify existing content was NOT overwritten
    for (const p of required) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      const raw = await readFile(dataPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ existing: true });
    }
  });

  test("blessed config takes precedence over CLI default when present", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    const required = requiredPlugins(manifest);
    const target = required[0]!; // Use first required plugin

    // Write a blessed config that differs from the CLI default
    const blessedContent = { marker: "blessed", source: "blessed-config" };
    await writeFile(
      join(vault, ".wiki", "blessed-config", `${target.id}.json`),
      JSON.stringify(blessedContent, null, 2) + "\n"
    );

    await writePluginConfigs(vault, manifest);

    // Verify the written data.json matches blessed, not CLI default
    const dataPath = join(vault, ".obsidian", "plugins", target.id, "data.json");
    const raw = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(blessedContent);

    const cliDefault = await loadDefaultConfig(target);
    expect(parsed).not.toEqual(cliDefault);
  });

  test("written config matches the CLI-bundled default content", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    await writePluginConfigs(vault, manifest);

    const required = requiredPlugins(manifest);
    for (const p of required) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      const raw = await readFile(dataPath, "utf8");
      const parsed = JSON.parse(raw);
      const expected = await loadDefaultConfig(p);
      expect(parsed).toEqual(expected);
    }
  });

  test("written config from blessed matches the blessed content", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    const required = requiredPlugins(manifest);

    // Write blessed configs for all required plugins
    const blessedConfigs: Record<string, Record<string, unknown>> = {};
    for (const p of required) {
      const content = { blessed: true, pluginId: p.id };
      blessedConfigs[p.id] = content;
      await writeFile(
        join(vault, ".wiki", "blessed-config", `${p.id}.json`),
        JSON.stringify(content, null, 2) + "\n"
      );
    }

    await writePluginConfigs(vault, manifest);

    for (const p of required) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      const raw = await readFile(dataPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(blessedConfigs[p.id]);
    }
  });

  test("works for all 5 required plugins", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    const required = requiredPlugins(manifest);
    expect(required).toHaveLength(5);

    const result = await writePluginConfigs(vault, manifest);

    expect(result.written).toHaveLength(5);
    expect(result.skipped).toHaveLength(0);

    for (const p of required) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      const raw = await readFile(dataPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toBeDefined();
    }
  });

  test("result has correct written/skipped lists", async () => {
    manifest = await loadPluginManifest();
    const vault = await makeTempVault(manifest);

    const required = requiredPlugins(manifest);
    // Pre-write data.json for first two plugins only
    const preExisting = required.slice(0, 2);
    const missing = required.slice(2);

    for (const p of preExisting) {
      const dataPath = join(vault, ".obsidian", "plugins", p.id, "data.json");
      await writeFile(dataPath, JSON.stringify({ pre: true }, null, 2) + "\n");
    }

    const result = await writePluginConfigs(vault, manifest);

    expect(result.skipped.sort()).toEqual(preExisting.map((p) => p.id).sort());
    expect(result.written.sort()).toEqual(missing.map((p) => p.id).sort());
  });
});
