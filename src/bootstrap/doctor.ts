import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openArtifact, readFrontmatter, serializeArtifact } from "../artifacts/artifact-file";
import { buildIdIndex } from "../artifacts/id-index";
import { nextId } from "../artifacts/id";
import { bareIdOf, collectPathLinks, collectReferences, isLocalIdRef } from "../artifacts/references";
import { loadStructure, type Structure } from "../artifacts/registry";
import { slugifyTitle } from "../artifacts/store";
import { withProjectLock } from "../artifacts/lock";
import { BLOCK_VERSION } from "../cli/repo-link";
import { exists } from "../util";

export type DriftIssue = {
  type:
    | "docs-structure"
    | "repo-binding"
    | "repo-binding-warning"
    | "contract-drift"
    | "duplicate-id"
    | "dangling-link";
  message: string;
};

export type DoctorResult = {
  issues: DriftIssue[];
  clean: boolean; // true when issues.length === 0
};

/**
 * Vault content checks (Obsidian is a viewer now, so there's no plugin/config/template
 * drift to police — just the vault's own invariants):
 *  - docs-structure: every branch-section folder holds only its config-declared
 *    bucket subfolders and no loose files (the no-loose-files invariant of ADR-0028,
 *    now expressed through the per-vault config tree, PRD-0019).
 *  - repo-binding: every linked repo carries a current-version wiki block (and no
 *    contract-drift artifacts like a local CONTEXT.md / docs/adr/).
 */
export async function runDoctor(vaultPath: string, scopeProject?: string): Promise<DoctorResult> {
  const issues: DriftIssue[] = [];
  const structure = await loadStructure(vaultPath);
  const projects = await listVaultProjects(vaultPath);
  const targets = scopeProject !== undefined ? projects.filter((p) => p === scopeProject) : projects;
  for (const project of targets) {
    issues.push(...(await checkProjectDocsStructure(vaultPath, project, structure)));
    issues.push(...(await checkProjectRepoBindings(vaultPath, project, structure)));
    issues.push(...(await checkProjectIdDrift(vaultPath, project, structure)));
  }
  return { issues, clean: issues.length === 0 };
}

/**
 * Identity drift for one project, both backed by the frontmatter-`id` index (the
 * single spine from PRD-0013):
 *  - duplicate-id: any id mapping to more than one file (silent shadowing).
 *  - dangling-link: any frontmatter link value or `[[id]]` body wikilink whose bare,
 *    registered-prefix id is absent from the project id set. Cross-project
 *    (path-qualified) and cross-prefix (unknown-prefix) references are skipped by
 *    design — shared-ADR references are not false dangles.
 */
export async function checkProjectIdDrift(vaultPath: string, project: string, structure: Structure): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  const index = await buildIdIndex(vaultPath, project, structure);

  for (const [id, paths] of index) {
    if (paths.length > 1) {
      issues.push({
        type: "duplicate-id",
        message: `${project}: id ${id} maps to ${paths.length} files (${paths.map((p) => p.split("/").pop()).join(", ")}) — ids must be unique. Renumber or merge the duplicates.`,
      });
    }
  }

  const known = new Set(index.keys());
  for (const paths of index.values()) {
    for (const path of paths) {
      for (const ref of await collectReferences(path)) {
        const id = bareIdOf(ref);
        if (id === undefined || !isLocalIdRef(id, structure)) continue; // cross-project / cross-prefix
        if (!known.has(id)) {
          issues.push({
            type: "dangling-link",
            message: `${project}: ${path.split("/").pop()} references ${id}, which has no artifact in this project — fix the link or restore the target.`,
          });
        }
      }
    }
  }

  // Second pass: validate path-qualified wikilinks (e.g. [[projects/foo/specs/prds/PRD-009]])
  for (const paths of index.values()) {
    for (const path of paths) {
      for (const target of await collectPathLinks(path)) {
        const full = join(vaultPath, target);
        const fullMd = full.endsWith(".md") ? full : `${full}.md`;
        if (await exists(full)) continue;
        if (await exists(fullMd)) continue;
        issues.push({
          type: "dangling-link",
          message: `${project}: ${path.split("/").pop()} references path '${target}', which does not exist in the vault — fix or remove the link.`,
        });
      }
    }
  }

  return issues;
}

/** What {@link repairDuplicateIds} changed for one project. */
export type DuplicateRepair = {
  /** Human-readable `OLD maps to N files; FILE -> NEW` lines, one per reassigned file. */
  labels: string[];
  /** Count of files reassigned a fresh id. */
  reassigned: number;
};

/**
 * Repair duplicate frontmatter ids in one project (SLICE-0122). When an id maps
 * to more than one file, the lexicographically-first path keeps the id (canonical)
 * and every other file is reassigned the next free id in that section's id-space
 * via {@link nextId} (the same seam create uses, so the new id never re-collides).
 * The reassigned file's own `id`, `aliases`, and any self-referential `[[OLD]]` body
 * links are rewritten so it stays internally consistent; the canonical file is
 * untouched, so inbound `[[OLD]]` links from other files still resolve to it.
 *
 * Renaming the reassigned file to `<newid>-<slug>.md` is left to the fmt rename
 * pass that runs after this — only the frontmatter id moves here, which is enough
 * for the next {@link nextId} read to see the freshly minted id and not re-mint it.
 *
 * Review follow-up (P2c): the renumber runs under the per-project lock, the same
 * seam create/capture allocate under, so a concurrent `wiki create` cannot mint an
 * id this repair is about to hand out (and vice versa).
 */
export async function repairDuplicateIds(
  vaultRoot: string,
  project: string,
  structure: Structure,
): Promise<DuplicateRepair> {
  return withProjectLock(vaultRoot, project, () => repairDuplicateIdsLocked(vaultRoot, project, structure));
}

async function repairDuplicateIdsLocked(
  vaultRoot: string,
  project: string,
  structure: Structure,
): Promise<DuplicateRepair> {
  const labels: string[] = [];
  let reassigned = 0;
  const index = await buildIdIndex(vaultRoot, project, structure);

  for (const [id, paths] of index) {
    if (paths.length <= 1) continue;
    const type = structure.typeForId(id);
    if (type === undefined) continue; // unknown prefix — not ours to renumber
    // Canonical = lexicographically-first path keeps the id; reassign the rest.
    const [, ...duplicates] = [...paths].sort();
    for (const dupPath of duplicates) {
      const newId = await nextId(type, vaultRoot, project, structure);
      await reassignId(dupPath, id, newId);
      labels.push(`${project}: id ${id} maps to ${paths.length} files; ${dupPath.split("/").pop()} -> ${newId}`);
      reassigned++;
    }
  }

  return { labels, reassigned };
}

/** Rewrite one file's frontmatter `id` (and matching `aliases`) plus any self
 *  `[[oldId]]` body links to `newId`, then rename it to `<newId>-<slug>.md`. */
async function reassignId(filePath: string, oldId: string, newId: string): Promise<void> {
  const file = await openArtifact(filePath);
  const data = { ...file.data };
  data.id = newId;
  if (Array.isArray(data.aliases)) {
    const aliases = data.aliases.map((a) => (a === oldId ? newId : a));
    if (!aliases.includes(newId)) aliases.unshift(newId);
    data.aliases = aliases;
  }
  // Self-references only: a file that links to its own old id now links to the new one.
  const body = file.body.replace(new RegExp(`\\[\\[${oldId}(?=[\\]|#])`, "g"), `[[${newId}`);
  const content = serializeArtifact(data, body);
  const title = typeof data.title === "string" ? data.title : newId;
  const target = join(dirname(filePath), `${newId}-${slugifyTitle(title)}.md`);
  await writeFile(target, content);
  if (target !== filePath) await rm(filePath, { force: true });
}
export async function listVaultProjects(vaultPath: string): Promise<string[]> {
  const projectsDir = join(vaultPath, "projects");
  if (!(await exists(projectsDir))) return [];
  return (await readdir(projectsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
}

/**
 * Structure invariant for one project, read from the per-vault config tree (PRD-0019):
 * every branch section's folder may contain only its config-declared bucket subfolders,
 * and no loose files directly inside it (every artifact lives in a bucket — the
 * no-loose-files invariant of ADR-0028, now config-declared rather than a hardcoded
 * category lock). Leaf sections hold artifacts directly and are not policed here.
 * This validates structural truth only: it never emits a fuzzy "wrong bucket" warning,
 * since bucket fitness is the authoring agent's judgment. Reused by `wiki doctor`
 * (audit) and `wiki sync` (gate before re-embedding) so the rule has one implementation.
 */
export async function checkProjectDocsStructure(
  vaultPath: string,
  project: string,
  structure: Structure,
): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  const projectDir = join(vaultPath, "projects", project);
  for (const section of structure.sections) {
    if (section.tree !== "branch") continue;
    const allowed = new Set(section.buckets.map((b) => b.folder.slice(section.folder.length + 1)));
    const sectionDir = join(projectDir, section.folder);
    if (!(await exists(sectionDir))) continue;
    for (const entry of await readdir(sectionDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!allowed.has(entry.name)) {
          issues.push({
            type: "docs-structure",
            message: `${project}: ${section.folder}/${entry.name}/ is not a declared bucket of section '${section.name}' — declare it in wiki.json or move its contents into a bucket. Buckets: ${[...allowed].join(", ")}.`,
          });
        }
      } else if (entry.name.endsWith(".md")) {
        issues.push({
          type: "docs-structure",
          message: `${project}: ${section.folder}/${entry.name} sits directly under ${section.folder}/ — a branch section holds no loose files; every artifact belongs in a bucket. Recreate via 'wiki create <bucket>' or move it into a bucket.`,
        });
      }
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
export async function checkProjectRepoBindings(vaultPath: string, project: string, structure: Structure): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  const projectMdPath = join(vaultPath, "projects", project, "_project.md");

  let raw: string;
  try {
    raw = await readFile(projectMdPath, "utf8");
  } catch {
    return issues; // No _project.md — skip
  }

  const parsed = readFrontmatter(raw);
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
            message: `${project}: ${file} in repo '${repoPath}' is missing — run: wiki project link --project ${project} --repo ${repoPath}`,
          });
        } else {
          // Unreadable file — degrade to warning
          issues.push({
            type: "repo-binding-warning",
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
          message: `${project}: ${file} in repo '${repoPath}' is missing the wiki block — run: wiki project link --project ${project} --repo ${repoPath}`,
        });
        continue;
      }

      const blockVersion = parseInt(match[1]!, 10);
      if (blockVersion !== BLOCK_VERSION) {
        issues.push({
          type: "repo-binding",
          message: `${project}: ${file} in repo '${repoPath}' has a stale wiki block (v${blockVersion}, current is v${BLOCK_VERSION}) — run: wiki project link --project ${project} --repo ${repoPath}`,
        });
      }
    }

    issues.push(...(await checkRepoContractDrift(project, repoPath, structure)));
  }

  return issues;
}

/**
 * Contract-drift check (ADR-0032 Layer 2): a bound repo must not carry the artifacts
 * upstream skills try to write locally — a root CONTEXT.md (glossary) or docs/adr/.
 * Prevention via guidance is probabilistic; this is the detection net.
 */

/** Derive the remediation command for a CONTEXT.md contract-drift issue.
 *  If the structure has a `doc` kind with a `notes` bucket, use the legacy
 *  phrasing; if there's a top-level `notes` kind, use that; otherwise fall
 *  back to a generic placeholder. */
function contextMdRemediationCmd(project: string, structure: Structure): string {
  // Check if there's a doc kind with a notes bucket (legacy 5-kind layout)
  const docBucket = structure.bucketFor("notes");
  if (docBucket !== undefined && docBucket.section.name === "doc") {
    return `wiki create notes --project ${project}`;
  }
  // Check if "notes" is a top-level kind (post-migration 10-kind layout)
  if (structure.kinds["notes"] !== undefined) {
    return `wiki create notes --project ${project}`;
  }
  return `wiki create <kind> --project ${project}`;
}

async function checkRepoContractDrift(project: string, repoPath: string, structure: Structure): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];

  if (await exists(join(repoPath, "CONTEXT.md"))) {
    const createCmd = contextMdRemediationCmd(project, structure);
    issues.push({
      type: "contract-drift",
      message: `${project}: repo '${repoPath}' contains CONTEXT.md — glossary terms belong in the vault. Recreate each term via '${createCmd}', then delete the repo file.`,
    });
  }

  const adrDir = join(repoPath, "docs", "adr");
  if (await exists(adrDir)) {
    const adrFiles = (await readdir(adrDir)).filter((name) => name.endsWith(".md")).sort();
    if (adrFiles.length > 0) {
      issues.push({
        type: "contract-drift",
        message: `${project}: repo '${repoPath}' contains docs/adr/ files (${adrFiles.join(", ")}) — decisions belong in the vault. Recreate each via 'wiki create decision --project ${project}', then delete the repo files.`,
      });
    }
  }

  return issues;
}
