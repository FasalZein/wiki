import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

import { loadPluginManifest, requiredPlugins, loadDefaultConfig } from "./manifest";
import { readLockfile } from "./plugins";
import { DOC_CATEGORIES } from "../artifacts/registry";
import { BLOCK_VERSION } from "../cli/repo-link";

export type DriftIssue = {
  type:
    | "missing-plugin"
    | "version-mismatch"
    | "config-drift"
    | "missing-template"
    | "community-plugins-mismatch"
    | "plugin-checks-skipped"
    | "docs-structure"
    | "repo-binding"
    | "repo-binding-warning"
    | "contract-drift";
  plugin?: string;
  template?: string;
  project?: string;
  expected?: string;
  actual?: string;
  message: string;
};

export type DoctorResult = {
  issues: DriftIssue[];
  clean: boolean; // true when issues.length === 0
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(
  vaultPath: string,
  repoRoot: string,
): Promise<DoctorResult> {
  const issues: DriftIssue[] = [];

  const manifest = await loadPluginManifest();
  const required = requiredPlugins(manifest);
  // The plugin/template checks need the vault's plugin lockfile. On a vault that was
  // never `wiki vault init`'d (no .wiki/plugin-lock.json) this read throws — which used
  // to abort doctor entirely, silently skipping the docs-structure check below. Degrade
  // gracefully: report the missing setup as one issue and skip only the plugin/template
  // checks, so docs-structure (and any future vault-content check) still runs.
  const lockfile = await readLockfile(vaultPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });

  if (lockfile === null) {
    issues.push({
      type: "plugin-checks-skipped",
      message: "plugin/template checks skipped: no .wiki/plugin-lock.json (run 'wiki vault init' to provision plugins). Docs-structure check still ran.",
    });
  } else {
  // 1. Missing required plugins
  const installedRequired: string[] = [];
  for (const entry of required) {
    const manifestPath = join(
      vaultPath,
      ".obsidian",
      "plugins",
      entry.id,
      "manifest.json",
    );
    if (!(await exists(manifestPath))) {
      issues.push({
        type: "missing-plugin",
        plugin: entry.id,
        message: `required plugin "${entry.id}" is not installed`,
      });
    } else {
      installedRequired.push(entry.id);
    }
  }

  // 2. Version mismatch (only for installed required plugins)
  for (const entry of required) {
    if (!installedRequired.includes(entry.id)) continue;

    const lockEntry = lockfile.plugins[entry.id];
    if (!lockEntry) continue;

    const manifestPath = join(
      vaultPath,
      ".obsidian",
      "plugins",
      entry.id,
      "manifest.json",
    );
    const raw = await readFile(manifestPath, "utf8");
    const diskManifest = JSON.parse(raw) as { version: string };

    if (diskManifest.version !== lockEntry.version) {
      issues.push({
        type: "version-mismatch",
        plugin: entry.id,
        expected: lockEntry.version,
        actual: diskManifest.version,
        message: `plugin "${entry.id}" version mismatch: lockfile expects ${lockEntry.version}, installed is ${diskManifest.version}`,
      });
    }
  }

  // 3. Config drift (only for installed required plugins)
  for (const entry of required) {
    if (!installedRequired.includes(entry.id)) continue;

    const dataPath = join(
      vaultPath,
      ".obsidian",
      "plugins",
      entry.id,
      "data.json",
    );
    if (!(await exists(dataPath))) continue;

    const dataRaw = await readFile(dataPath, "utf8");
    const dataObj = JSON.parse(dataRaw);
    const dataNormalized = JSON.stringify(dataObj);

    // Blessed config takes precedence over CLI default
    const blessedPath = join(
      vaultPath,
      ".wiki",
      "blessed-config",
      `${entry.id}.json`,
    );

    let expectedObj: Record<string, unknown>;
    if (await exists(blessedPath)) {
      const blessedRaw = await readFile(blessedPath, "utf8");
      expectedObj = JSON.parse(blessedRaw);
    } else {
      expectedObj = await loadDefaultConfig(entry);
    }

    const expectedNormalized = JSON.stringify(expectedObj);

    if (dataNormalized !== expectedNormalized) {
      issues.push({
        type: "config-drift",
        plugin: entry.id,
        message: `plugin "${entry.id}" config has drifted from ${await exists(blessedPath) ? "blessed" : "default"} config`,
      });
    }
  }

  // 4. Missing templates
  const repoTemplatesDir = join(repoRoot, "templates");
  if (await exists(repoTemplatesDir)) {
    const entries = await readdir(repoTemplatesDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const vaultTemplatePath = join(vaultPath, "_templates", file);
      if (!(await exists(vaultTemplatePath))) {
        issues.push({
          type: "missing-template",
          template: file,
          message: `template "${file}" is missing from vault _templates/`,
        });
      }
    }
  }

  // 5. community-plugins.json mismatch
  const cpPath = join(vaultPath, ".obsidian", "community-plugins.json");
  if (await exists(cpPath)) {
    const cpRaw = await readFile(cpPath, "utf8");
    const cpList: string[] = JSON.parse(cpRaw);

    // Get actual installed plugin dirs
    const pluginsDir = join(vaultPath, ".obsidian", "plugins");
    let installedDirs: string[] = [];
    if (await exists(pluginsDir)) {
      const allEntries = await readdir(pluginsDir);
      // Only count dirs that have a manifest.json (actual plugins)
      const checks = await Promise.all(
        allEntries.map(async (d) => ({
          name: d,
          isPlugin: await exists(join(pluginsDir, d, "manifest.json")),
        })),
      );
      installedDirs = checks.filter((c) => c.isPlugin).map((c) => c.name);
    }

    const cpSet = new Set(cpList);
    const installedSet = new Set(installedDirs);

    if (
      cpSet.size !== installedSet.size ||
      [...cpSet].some((id) => !installedSet.has(id)) ||
      [...installedSet].some((id) => !cpSet.has(id))
    ) {
      const inListNotDisk = [...cpSet].filter((id) => !installedSet.has(id));
      const onDiskNotList = [...installedSet].filter((id) => !cpSet.has(id));

      const parts: string[] = [];
      if (inListNotDisk.length > 0) {
        parts.push(`listed but not installed: ${inListNotDisk.join(", ")}`);
      }
      if (onDiskNotList.length > 0) {
        parts.push(`installed but not listed: ${onDiskNotList.join(", ")}`);
      }

      issues.push({
        type: "community-plugins-mismatch",
        message: `community-plugins.json does not match installed plugins — ${parts.join("; ")}`,
      });
    }
  }
  } // end plugin/template checks (skipped when no lockfile)

  // 6. Docs structure: docs/ holds only the locked category subfolders (ADR superseding
  //    0021/0022 — categorized model). Flag any out-of-set subfolder (the out-of-CLI
  //    folder-invention leak the CLI write paths cannot catch) and any loose file sitting
  //    directly under docs/ instead of inside a category folder.
  for (const project of await listVaultProjects(vaultPath)) {
    issues.push(...(await checkProjectDocsStructure(vaultPath, project)));
  }

  // 7. Repo-binding: for every project with linked_repos, verify each repo's
  //    AGENTS.md and CLAUDE.md contain a current-version wiki block.
  for (const project of await listVaultProjects(vaultPath)) {
    issues.push(...(await checkProjectRepoBindings(vaultPath, project)));
  }

  return { issues, clean: issues.length === 0 };
}

/** Project directories under the vault (excludes _-prefixed structural dirs). */
export async function listVaultProjects(vaultPath: string): Promise<string[]> {
  const projectsDir = join(vaultPath, "projects");
  if (!(await exists(projectsDir))) return [];
  return (await readdir(projectsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
}

/**
 * Docs-structure invariant (ADR-0028) for one project: docs/ may contain only the locked
 * category subfolders, and every doc must live inside one (no loose files directly under
 * docs/). Returns the violations as DriftIssues. Reused by `wiki doctor` (audit) and
 * `wiki sync` (gate before re-embedding) so the rule has one implementation.
 */
export async function checkProjectDocsStructure(vaultPath: string, project: string): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  const locked = new Set<string>(DOC_CATEGORIES);
  const docsDir = join(vaultPath, "projects", project, "docs");
  if (!(await exists(docsDir))) return issues;
  for (const entry of await readdir(docsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!locked.has(entry.name)) {
        issues.push({
          type: "docs-structure",
          project,
          actual: entry.name,
          message: `${project}: docs/${entry.name}/ is not a locked category — docs must live in one of: ${DOC_CATEGORIES.join(", ")}. Move its docs with 'wiki doc recategorize' or remove the folder.`,
        });
      }
    } else if (entry.name.endsWith(".md")) {
      issues.push({
        type: "docs-structure",
        project,
        actual: entry.name,
        message: `${project}: docs/${entry.name} sits directly under docs/ — docs belong inside a locked category folder, not loose. Recreate via 'wiki create doc' or move it into a category.`,
      });
    }
  }
  return issues;
}

/** Sentinel regex for any version wiki block. */
const WIKI_BLOCK_BEGIN_RE = /<!-- wiki:begin v(\d+) project=[^\s]+ -->/;
const WIKI_BLOCK_END = "<!-- wiki:end -->";
const WIKI_BLOCK_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Repo-binding check: for every linked repo in a project, verify AGENTS.md and CLAUDE.md
 * have a current-version wiki block. Returns DriftIssues for any missing, stale, or
 * unreadable bindings.
 */
export async function checkProjectRepoBindings(vaultPath: string, project: string): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  const projectMdPath = join(vaultPath, "projects", project, "_project.md");

  let raw: string;
  try {
    raw = await readFile(projectMdPath, "utf8");
  } catch {
    return issues; // No _project.md — skip
  }

  const parsed = matter(raw);
  const linkedRepos = parsed.data.linked_repos;
  if (!Array.isArray(linkedRepos) || linkedRepos.length === 0) return issues;

  for (const repoPath of linkedRepos) {
    if (typeof repoPath !== "string") continue;

    // Check repo accessibility first — degrade to warning if unreadable
    try {
      await access(repoPath);
    } catch {
      issues.push({
        type: "repo-binding-warning",
        project,
        message: `${project}: linked repo '${repoPath}' is not accessible — skipping block check. Remove it from linked_repos or restore the path.`,
      });
      continue;
    }

    for (const file of WIKI_BLOCK_FILES) {
      const filePath = join(repoPath, file);
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          // File absent — flag as missing
          issues.push({
            type: "repo-binding",
            project,
            message: `${project}: ${file} in repo '${repoPath}' is missing — run: wiki project link --project ${project} --repo ${repoPath}`,
          });
        } else {
          // Unreadable file — degrade to warning
          issues.push({
            type: "repo-binding-warning",
            project,
            message: `${project}: ${file} in repo '${repoPath}' could not be read — skipping block check.`,
          });
        }
        continue;
      }

      const match = WIKI_BLOCK_BEGIN_RE.exec(content);
      if (match === null || !content.includes(WIKI_BLOCK_END)) {
        // No block present
        issues.push({
          type: "repo-binding",
          project,
          message: `${project}: ${file} in repo '${repoPath}' is missing the wiki block — run: wiki project link --project ${project} --repo ${repoPath}`,
        });
        continue;
      }

      const blockVersion = parseInt(match[1]!, 10);
      if (blockVersion !== BLOCK_VERSION) {
        issues.push({
          type: "repo-binding",
          project,
          message: `${project}: ${file} in repo '${repoPath}' has a stale wiki block (v${blockVersion}, current is v${BLOCK_VERSION}) — run: wiki project link --project ${project} --repo ${repoPath}`,
        });
      }
    }

    issues.push(...(await checkRepoContractDrift(project, repoPath)));
  }

  return issues;
}

/**
 * Contract-drift check (ADR-0032 Layer 2): a bound repo must not carry the artifacts
 * upstream skills try to write locally — a root CONTEXT.md (glossary) or docs/adr/.
 * Prevention via guidance is probabilistic; this is the detection net.
 */
async function checkRepoContractDrift(project: string, repoPath: string): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];

  if (await exists(join(repoPath, "CONTEXT.md"))) {
    issues.push({
      type: "contract-drift",
      project,
      message: `${project}: repo '${repoPath}' contains CONTEXT.md — glossary terms belong in the vault. Recreate each term via 'wiki create doc --project ${project} --type reference', then delete the repo file.`,
    });
  }

  const adrDir = join(repoPath, "docs", "adr");
  if (await exists(adrDir)) {
    const adrFiles = (await readdir(adrDir)).filter((name) => name.endsWith(".md")).sort();
    if (adrFiles.length > 0) {
      issues.push({
        type: "contract-drift",
        project,
        message: `${project}: repo '${repoPath}' contains docs/adr/ files (${adrFiles.join(", ")}) — decisions belong in the vault. Recreate each via 'wiki create decision --project ${project}', then delete the repo files.`,
      });
    }
  }

  return issues;
}
