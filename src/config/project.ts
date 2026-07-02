import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { readFrontmatter } from "../artifacts/artifact-file";
import { type Structure } from "../artifacts/registry";
import { isFileNotFound } from "../util";

export type ProjectConfig = {
  repo: string;
  qmd_command: string;
  dedup_threshold_weak: number;
  dedup_threshold_strong: number;
  /** Opt-in strict mode: when true, a strong dedup match blocks create unless an override flag is passed.
   * Default false — dedup is advisory (warn + link), matching a general memory layer; blocking is opt-in per project. */
  dedup_strong_blocks: boolean;
};

export class ProjectConfigError extends Error {
  constructor(message?: string) {
    super(message ?? "_project.md not found");
  }
}

/** List the project names that exist under <vaultRoot>/projects (excluding _archived).
 *  A project is one whose directory carries the `_project.md` marker — the same
 *  signal `projectExists`/`resolveProject` key on. Listing bare directories would
 *  surface half-created dirs (no `_project.md`) that then fail to resolve/sync
 *  (BUG-9, NOTE-0007). */
export async function listProjects(vaultRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(vaultRoot, "projects"), { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
    const marked = await Promise.all(
      dirs.map(async (name) => ((await projectExists(vaultRoot, name)) ? name : undefined)),
    );
    return marked.filter((n): n is string => n !== undefined).sort();
  } catch {
    return [];
  }
}

/** True when a project exists in the vault — keyed on its `_project.md` marker,
 *  the same file `wiki project create` writes and `assertProjectStructure` requires. */
export async function projectExists(vaultRoot: string, project: string): Promise<boolean> {
  try {
    await stat(join(vaultRoot, "projects", project, "_project.md"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an actionable message for a project-resolution failure: a nonexistent
 * project (suggest `wiki project create`), listing the projects that do exist.
 */
export async function projectErrorMessage(vaultRoot: string, project: string): Promise<string> {
  const available = await listProjects(vaultRoot);
  const list = available.length > 0 ? `\navailable projects: ${available.join(", ")}` : "\nno projects exist yet";
  return `project '${project}' not found — create it with: wiki project create ${project}${list}`;
}

export async function assertProjectStructure(projectPath: string, _structure: Structure): Promise<void> {
  // A project is identified by its `_project.md` alone. Kind folders are NOT
  // required to pre-exist: `mintAndWrite` mkdir-recursives the target on write,
  // and empty kind folders don't survive `git clone` (no .gitkeep), so a project
  // legitimately lacking docs of some kind must still pass. Requiring every
  // `structure.folders` entry here broke `create`/`sync`/`fmt` after the doc-kind
  // promotion grew the kind set (BUG-1, NOTE-0007).
  await assertFile(join(projectPath, "_project.md"), "_project.md");
}

export async function loadProjectConfig(projectPath: string): Promise<ProjectConfig> {
  let content: string;
  try {
    content = await readFile(join(projectPath, "_project.md"), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new ProjectConfigError("missing");
    }
    throw error;
  }
  const data = readFrontmatter(content).data;
  return {
    repo: isNonEmptyString(data.repo) ? data.repo : projectPath,
    qmd_command: isNonEmptyString(data.qmd_command) ? data.qmd_command : "qmd",
    dedup_threshold_weak: numberValue(data.dedup_threshold_weak, 0.7),
    dedup_threshold_strong: numberValue(data.dedup_threshold_strong, 0.85),
    dedup_strong_blocks: typeof data.dedup_strong_blocks === "boolean" ? data.dedup_strong_blocks : false,
  };
}

async function assertFile(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      throw new Error(`Project structure missing ${label}`);
    }
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new Error(`Project structure missing ${label}`);
    }
    throw error;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
