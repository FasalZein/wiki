import matter from "gray-matter";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ARTIFACT_FOLDERS } from "../artifacts/registry";
import { expandHome, isFileNotFound } from "../util";

export type ProjectConfig = {
  repo: string;
  qmd_command: string;
  research_path: string;
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

/** List the project names that exist under <vaultRoot>/projects (excluding _archived). */
export async function listProjects(vaultRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(vaultRoot, "projects"), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
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

export async function assertProjectStructure(projectPath: string): Promise<void> {
  await assertFile(join(projectPath, "_project.md"), "_project.md");
  for (const folder of ARTIFACT_FOLDERS) {
    await assertDirectory(join(projectPath, folder), `${folder}/`);
  }
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
  const data = matter(content).data;
  return {
    repo: isNonEmptyString(data.repo) ? data.repo : projectPath,
    qmd_command: isNonEmptyString(data.qmd_command) ? data.qmd_command : "qmd",
    research_path: expandHome(isNonEmptyString(data.research_path) ? data.research_path : "~/.pi/artifacts/research"),
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

async function assertDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
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
