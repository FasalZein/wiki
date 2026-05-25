import { stat } from "node:fs/promises";
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

export async function assertProjectStructure(projectPath: string): Promise<void> {
  await assertFile(join(projectPath, "_project.md"), "_project.md");
  for (const folder of ["prds", "slices", "decisions", "handovers"]) {
    await assertDirectory(join(projectPath, folder), `${folder}/`);
  }
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

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
