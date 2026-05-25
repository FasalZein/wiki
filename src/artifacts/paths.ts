import { join } from "node:path";

import type { TemplateType } from "../schema/load";

export function artifactFolder(type: TemplateType): string {
  switch (type) {
    case "decision":
      return "decisions";
    case "prd":
      return "prds";
    case "slice":
      return "slices";
    case "handover":
      return "handovers";
  }
}

export function projectPath(vaultRoot: string, project: string): string {
  return join(vaultRoot, "projects", project);
}

export function artifactDirectory(type: TemplateType, vaultRoot: string, project: string): string {
  return join(projectPath(vaultRoot, project), artifactFolder(type));
}
