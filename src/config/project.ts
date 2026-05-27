import matter from "gray-matter";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type ProjectConfig = {
  repo: string;
  test_command: string;
  qmd_command: string;
  research_path: string;
  dedup_threshold_weak: number;
  dedup_threshold_strong: number;
};

export class ProjectConfigError extends Error {
  constructor() {
    super("_project.md: missing 'repo' or 'test_command'");
  }
}

export async function assertProjectStructure(projectPath: string): Promise<void> {
  await assertFile(join(projectPath, "_project.md"), "_project.md");
  for (const folder of ["prds", "slices", "adrs", "handovers"]) {
    await assertDirectory(join(projectPath, folder), `${folder}/`);
  }
}

export async function loadProjectConfig(projectPath: string, options: { requireLifecycle?: boolean } = {}): Promise<ProjectConfig> {
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
  if (options.requireLifecycle === true && (!isNonEmptyString(data.repo) || !isNonEmptyString(data.test_command))) {
    throw new ProjectConfigError();
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
