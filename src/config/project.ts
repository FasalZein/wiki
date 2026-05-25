import matter from "gray-matter";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { getVaultRoot } from "./vault";

export async function resolveCurrentProject(cwd = process.cwd()): Promise<string | null> {
  const projectsRoot = resolve(await getVaultRoot(), "projects");
  const relativePath = relative(projectsRoot, resolve(cwd));
  if (relativePath.length === 0 || relativePath.startsWith("..") || relativePath.startsWith(sep)) {
    return null;
  }
  const projectName = relativePath.split(sep)[0];
  return projectName === undefined || projectName.length === 0 ? null : projectName;
}

export type ProjectConfig = {
  repo: string;
  test_command: string;
  qmd_command: string;
  research_path: string;
};

export class ProjectConfigError extends Error {
  constructor() {
    super("_project.md: missing 'repo' or 'test_command'");
  }
}

export async function assertProjectStructure(projectPath: string): Promise<void> {
  await assertFile(join(projectPath, "_project.md"), "_project.md");
  for (const folder of ["prds", "slices", "decisions", "handovers"]) {
    await assertDirectory(join(projectPath, folder), `${folder}/`);
  }
}

export async function loadProjectConfig(projectPath: string): Promise<ProjectConfig> {
  let content: string;
  try {
    content = await readFile(join(projectPath, "_project.md"), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new ProjectConfigError();
    }
    throw error;
  }
  const data = matter(content).data;
  if (!isNonEmptyString(data.repo) || !isNonEmptyString(data.test_command)) {
    throw new ProjectConfigError();
  }
  return {
    repo: data.repo,
    test_command: data.test_command,
    qmd_command: isNonEmptyString(data.qmd_command) ? data.qmd_command : "qmd",
    research_path: expandHome(isNonEmptyString(data.research_path) ? data.research_path : "~/.pi/artifacts/research"),
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
