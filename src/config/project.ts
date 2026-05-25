import { relative, resolve, sep } from "node:path";

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

export async function assertProjectStructure(_projectPath: string): Promise<void> {
  return;
}
