import { afterEach, describe, expect, test } from "bun:test";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runDoctor } from "../src/bootstrap/doctor";
import { initVault } from "../src/bootstrap/init";
import {
  installPlugins,
  writeCommunityPlugins,
  updateLockfile,
  readLockfile,
} from "../src/bootstrap/plugins";
import { writePluginConfigs } from "../src/bootstrap/plugin-config";
import { deployTemplates } from "../src/bootstrap/templates";
import {
  loadPluginManifest,
  requiredPlugins,
  loadDefaultConfig,
} from "../src/bootstrap/manifest";
import type { PluginManifest } from "../src/bootstrap/manifest";

const FIXTURE_PLUGINS = resolve(import.meta.dir, "fixtures/plugins");

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a fully clean vault + synthetic repo root so runDoctor reports zero issues.
 */
async function makeCleanVault(): Promise<{
  vault: string;
  repoRoot: string;
  manifest: PluginManifest;
}> {
  const base = await mkdtemp(join(tmpdir(), "wiki-doctor-"));
  tempPaths.push(base);

  const vault = join(base, "vault");
  const repoRoot = join(base, "repo");

  // --- vault scaffold ---
  await initVault(vault);

  const manifest = await loadPluginManifest();
  const required = requiredPlugins(manifest);

  // Install plugins from fixtures
  await installPlugins(vault, manifest, { pluginSource: FIXTURE_PLUGINS });

  // Write default configs (respects blessed if present)
  await writePluginConfigs(vault, manifest);

  // Build lockfile entries from installed manifests
  const pluginsRecord: Record<string, { version: string; repo: string }> = {};
  for (const p of required) {
    const raw = await readFile(
      join(vault, ".obsidian", "plugins", p.id, "manifest.json"),
      "utf8",
    );
    const mJson = JSON.parse(raw);
    pluginsRecord[p.id] = { version: mJson.version, repo: p.repo };
  }
  await updateLockfile(vault, pluginsRecord);

  // Write community-plugins.json matching required ids
  await writeCommunityPlugins(
    vault,
    required.map((p) => p.id),
  );

  // --- synthetic repo root with templates ---
  const repoTemplates = join(repoRoot, "templates");
  await mkdir(repoTemplates, { recursive: true });
  await writeFile(join(repoTemplates, "note.md"), "# Note\n");
  await writeFile(join(repoTemplates, "daily.md"), "# Daily\n");

  // Deploy templates into vault
  const vaultTemplates = join(vault, "_templates");
  await deployTemplates(repoTemplates, vaultTemplates);

  return { vault, repoRoot, manifest };
}

describe("vault doctor", () => {
  test("clean vault reports no issues", async () => {
    const { vault, repoRoot } = await makeCleanVault();
    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("missing required plugin detected", async () => {
    const { vault, repoRoot } = await makeCleanVault();

    // Remove one plugin entirely
    await rm(join(vault, ".obsidian", "plugins", "dataview"), {
      recursive: true,
      force: true,
    });

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const missing = result.issues.filter((i) => i.type === "missing-plugin");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.plugin).toBe("dataview");

    // Should NOT also emit version-mismatch or config-drift for same plugin
    const otherIssuesForDataview = result.issues.filter(
      (i) =>
        i.plugin === "dataview" &&
        (i.type === "version-mismatch" || i.type === "config-drift"),
    );
    expect(otherIssuesForDataview).toHaveLength(0);
  });

  test("version mismatch detected", async () => {
    const { vault, repoRoot } = await makeCleanVault();

    // Modify lockfile to have a different version for dataview
    const lock = await readLockfile(vault);
    lock.plugins["dataview"]!.version = "99.0.0";
    await writeFile(
      join(vault, ".wiki", "plugin-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
    );

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const mismatch = result.issues.filter(
      (i) => i.type === "version-mismatch" && i.plugin === "dataview",
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.expected).toBe("99.0.0");
    expect(mismatch[0]!.actual).toBe("0.5.67");
  });

  test("config drift detected against CLI default", async () => {
    const { vault, repoRoot, manifest } = await makeCleanVault();

    // Mutate dataview's data.json so it differs from the default
    const dataPath = join(
      vault,
      ".obsidian",
      "plugins",
      "dataview",
      "data.json",
    );
    await writeFile(dataPath, JSON.stringify({ drifted: true }, null, 2) + "\n");

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const drift = result.issues.filter(
      (i) => i.type === "config-drift" && i.plugin === "dataview",
    );
    expect(drift).toHaveLength(1);
  });

  test("config drift against blessed config when blessed exists", async () => {
    const { vault, repoRoot, manifest } = await makeCleanVault();

    // Write a blessed config for dataview
    const blessedConfig = { blessed: true, source: "blessed" };
    await writeFile(
      join(vault, ".wiki", "blessed-config", "dataview.json"),
      JSON.stringify(blessedConfig, null, 2) + "\n",
    );

    // Also rewrite data.json to something different from blessed
    const dataPath = join(
      vault,
      ".obsidian",
      "plugins",
      "dataview",
      "data.json",
    );
    await writeFile(
      dataPath,
      JSON.stringify({ drifted: true }, null, 2) + "\n",
    );

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const drift = result.issues.filter(
      (i) => i.type === "config-drift" && i.plugin === "dataview",
    );
    expect(drift).toHaveLength(1);
  });

  test("config drift NOT reported when data.json matches despite formatting difference", async () => {
    const { vault, repoRoot, manifest } = await makeCleanVault();

    // Rewrite data.json with same content but different formatting
    const required = requiredPlugins(manifest);
    const dataview = required.find((p) => p.id === "dataview")!;
    const defaultConfig = await loadDefaultConfig(dataview);
    const dataPath = join(
      vault,
      ".obsidian",
      "plugins",
      "dataview",
      "data.json",
    );
    // Write with no indentation (different formatting, same semantics)
    await writeFile(dataPath, JSON.stringify(defaultConfig));

    const result = await runDoctor(vault, repoRoot);

    const drift = result.issues.filter(
      (i) => i.type === "config-drift" && i.plugin === "dataview",
    );
    expect(drift).toHaveLength(0);
  });

  test("missing template detected", async () => {
    const { vault, repoRoot } = await makeCleanVault();

    // Remove one template from vault
    await rm(join(vault, "_templates", "note.md"));

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const missing = result.issues.filter(
      (i) => i.type === "missing-template" && i.template === "note.md",
    );
    expect(missing).toHaveLength(1);
  });

  test("community-plugins.json mismatch — extra entry", async () => {
    const { vault, repoRoot, manifest } = await makeCleanVault();

    // Add an extra id to community-plugins.json that has no installed dir
    const cpPath = join(vault, ".obsidian", "community-plugins.json");
    const required = requiredPlugins(manifest);
    const ids = required.map((p) => p.id);
    ids.push("non-existent-plugin");
    await writeFile(cpPath, JSON.stringify(ids, null, 2) + "\n");

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const mismatch = result.issues.filter(
      (i) => i.type === "community-plugins-mismatch",
    );
    expect(mismatch).toHaveLength(1);
  });

  test("community-plugins.json mismatch — missing entry", async () => {
    const { vault, repoRoot, manifest } = await makeCleanVault();

    // Remove one id from community-plugins.json while the dir still exists
    const cpPath = join(vault, ".obsidian", "community-plugins.json");
    const required = requiredPlugins(manifest);
    const ids = required.map((p) => p.id).slice(1); // drop first
    await writeFile(cpPath, JSON.stringify(ids, null, 2) + "\n");

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    const mismatch = result.issues.filter(
      (i) => i.type === "community-plugins-mismatch",
    );
    expect(mismatch).toHaveLength(1);
  });

  test("optional plugins NOT flagged when missing", async () => {
    const { vault, repoRoot } = await makeCleanVault();

    // Optional plugins (obsidian-tasks-plugin, obsidian-meta-bind-plugin)
    // are not installed — ensure no issues
    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(true);
    const optionalIssues = result.issues.filter(
      (i) =>
        i.plugin === "obsidian-tasks-plugin" ||
        i.plugin === "obsidian-meta-bind-plugin",
    );
    expect(optionalIssues).toHaveLength(0);
  });

  test("multiple issues reported together", async () => {
    const { vault, repoRoot, manifest } = await makeCleanVault();

    // 1. Remove a plugin (missing-plugin)
    await rm(join(vault, ".obsidian", "plugins", "dataview"), {
      recursive: true,
      force: true,
    });

    // 2. Modify lockfile for a different plugin (version-mismatch)
    const lock = await readLockfile(vault);
    lock.plugins["templater-obsidian"]!.version = "99.0.0";
    await writeFile(
      join(vault, ".wiki", "plugin-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
    );

    // 3. Mutate config for yet another plugin (config-drift)
    await writeFile(
      join(vault, ".obsidian", "plugins", "obsidian-linter", "data.json"),
      JSON.stringify({ drifted: true }) + "\n",
    );

    // 4. Remove a template (missing-template)
    await rm(join(vault, "_templates", "daily.md"));

    // 5. Add bogus entry to community-plugins.json (mismatch)
    const cpPath = join(vault, ".obsidian", "community-plugins.json");
    const required = requiredPlugins(manifest);
    const ids = required.map((p) => p.id);
    ids.push("ghost-plugin");
    await writeFile(cpPath, JSON.stringify(ids, null, 2) + "\n");

    const result = await runDoctor(vault, repoRoot);

    expect(result.clean).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(5);

    const types = result.issues.map((i) => i.type);
    expect(types).toContain("missing-plugin");
    expect(types).toContain("version-mismatch");
    expect(types).toContain("config-drift");
    expect(types).toContain("missing-template");
    expect(types).toContain("community-plugins-mismatch");
  });

  test("docs-structure: a clean vault with only locked category folders reports no docs issues", async () => {
    const { vault, repoRoot } = await makeCleanVault();
    const docs = join(vault, "projects", "demo", "docs");
    await mkdir(join(docs, "architecture"), { recursive: true });
    await mkdir(join(docs, "research"));
    await writeFile(join(docs, "architecture", "DOC-0001-x.md"), "---\nid: DOC-0001\n---\n# x\n");

    const result = await runDoctor(vault, repoRoot);

    expect(result.issues.filter((i) => i.type === "docs-structure")).toHaveLength(0);
  });

  test("docs-structure: a rogue (non-locked) folder under docs/ is flagged", async () => {
    const { vault, repoRoot } = await makeCleanVault();
    const docs = join(vault, "projects", "demo", "docs");
    await mkdir(join(docs, "cracking"), { recursive: true });
    await writeFile(join(docs, "cracking", "note.md"), "# raw\n");

    const result = await runDoctor(vault, repoRoot);

    const docsIssues = result.issues.filter((i) => i.type === "docs-structure");
    expect(docsIssues.length).toBeGreaterThanOrEqual(1);
    expect(docsIssues[0]?.project).toBe("demo");
    expect(docsIssues[0]?.message).toContain("cracking");
  });

  test("docs-structure: a loose .md directly under docs/ is flagged", async () => {
    const { vault, repoRoot } = await makeCleanVault();
    const docs = join(vault, "projects", "demo", "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "DOC-0009-loose.md"), "---\nid: DOC-0009\n---\n# loose\n");

    const result = await runDoctor(vault, repoRoot);

    const docsIssues = result.issues.filter((i) => i.type === "docs-structure");
    expect(docsIssues.length).toBeGreaterThanOrEqual(1);
    expect(docsIssues[0]?.message).toContain("loose");
  });

  test("doctor degrades gracefully without a plugin lockfile and still runs docs-structure", async () => {
    // A vault that was never `wiki vault init`'d: no .wiki/plugin-lock.json. Doctor used to
    // throw here, skipping the docs-structure check entirely. It must instead report the
    // missing setup and still flag a rogue docs folder.
    const base = await mkdtemp(join(tmpdir(), "wiki-nolock-"));
    tempPaths.push(base);
    const vault = join(base, "vault");
    await mkdir(join(vault, "projects", "demo", "docs", "cracking"), { recursive: true });
    await writeFile(join(vault, "projects", "demo", "docs", "cracking", "x.md"), "# raw\n");

    const result = await runDoctor(vault, base);

    expect(result.issues.some((i) => i.type === "plugin-checks-skipped")).toBe(true);
    const docsIssues = result.issues.filter((i) => i.type === "docs-structure");
    expect(docsIssues.length).toBeGreaterThanOrEqual(1);
    expect(docsIssues[0]?.message).toContain("cracking");
  });
});
