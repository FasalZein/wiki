import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

import { DOC_CATEGORIES } from "../artifacts/registry";
import { BLOCK_VERSION } from "../cli/repo-link";

export type DriftIssue = {
  type:
    | "docs-structure"
    | "repo-binding"
    | "repo-binding-warning"
    | "contract-drift";
  project?: string;
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

/**
 * Vault content checks (Obsidian is a viewer now, so there's no plugin/config/template
 * drift to police — just the vault's own invariants):
 *  - docs-structure: docs/ holds only the locked category subfolders (ADR-0028).
 *  - repo-binding: every linked repo carries a current-version wiki block (and no
 *    contract-drift artifacts like a local CONTEXT.md / docs/adr/).
 */
export async function runDoctor(vaultPath: string): Promise<DoctorResult> {
  const issues: DriftIssue[] = [];
  for (const project of await listVaultProjects(vaultPath)) {
    issues.push(...(await checkProjectDocsStructure(vaultPath, project)));
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
