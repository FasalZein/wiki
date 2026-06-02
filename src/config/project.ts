import matter from "gray-matter";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ARTIFACT_FOLDERS } from "../artifacts/registry";

export type ProjectConfig = {
  repo: string;
  test_command: string;
  qmd_command: string;
  research_path: string;
  dedup_threshold_weak: number;
  dedup_threshold_strong: number;
};

export type ProjectConfigErrorKind = "missing" | "incomplete";

export class ProjectConfigError extends Error {
  readonly kind: ProjectConfigErrorKind;
  constructor(kind: ProjectConfigErrorKind = "incomplete", message?: string) {
    super(message ?? "_project.md: missing 'repo' or 'test_command'");
    this.kind = kind;
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
 * Build an actionable message for a project-resolution failure: distinguishes a
 * nonexistent project (suggest `wiki project create`) from an incomplete one
 * (name the missing field), and lists the projects that do exist.
 */
export async function projectErrorMessage(vaultRoot: string, project: string, error: ProjectConfigError): Promise<string> {
  const available = await listProjects(vaultRoot);
  const list = available.length > 0 ? `\navailable projects: ${available.join(", ")}` : "\nno projects exist yet";
  if (error.kind === "missing") {
    return `project '${project}' not found — create it with: wiki project create ${project}${list}`;
  }
  return `project '${project}' is incomplete: _project.md is missing 'repo' and/or 'test_command'. Add both fields to projects/${project}/_project.md.${list}`;
}

export async function assertProjectStructure(projectPath: string): Promise<void> {
  await assertFile(join(projectPath, "_project.md"), "_project.md");
  for (const folder of ARTIFACT_FOLDERS) {
    await assertDirectory(join(projectPath, folder), `${folder}/`);
  }
}

export async function loadProjectConfig(projectPath: string, options: { requireLifecycle?: boolean } = {}): Promise<ProjectConfig> {
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
  if (options.requireLifecycle === true && (!isNonEmptyString(data.repo) || !isNonEmptyString(data.test_command))) {
    throw new ProjectConfigError("incomplete");
  }
  return {
    repo: isNonEmptyString(data.repo) ? data.repo : projectPath,
    test_command: isNonEmptyString(data.test_command) ? data.test_command : "bun test",
    qmd_command: isNonEmptyString(data.qmd_command) ? data.qmd_command : "qmd",
    research_path: expandHome(isNonEmptyString(data.research_path) ? data.research_path : "~/.pi/artifacts/research"),
    dedup_threshold_weak: numberValue(data.dedup_threshold_weak, 0.7),
    dedup_threshold_strong: numberValue(data.dedup_threshold_strong, 0.85),
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

function expandHome(path: string): string {
  if (path === "~") {
    return homeDirectory();
  }
  if (path.startsWith("~/")) {
    return `${homeDirectory()}${path.slice(1)}`;
  }
  return path;
}

function homeDirectory(): string {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is not set");
  }
  return home;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
