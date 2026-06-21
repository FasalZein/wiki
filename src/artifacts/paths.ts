import { join } from "node:path";

import type { TemplateType } from "../schema/load";
import { specFor } from "./registry";

export function artifactFolder(type: TemplateType): string {
  return specFor(type).folder;
}

export function projectPath(vaultRoot: string, project: string): string {
  return join(vaultRoot, "projects", project);
}

export function artifactDirectory(type: TemplateType, vaultRoot: string, project: string): string {
  return join(projectPath(vaultRoot, project), artifactFolder(type));
}
