import { join } from "node:path";

import type { TemplateType } from "../schema/load";
import { type Structure } from "./registry";

export function artifactFolder(type: TemplateType, structure: Structure): string {
  return structure.specFor(type).folder;
}

/** Reject a path segment that could escape its parent directory. Project names and
 *  artifact ids are turned into file paths; neither may contain separators or `..`.
 *  ponytail: one guard for both — separators + dot-segments + empties is the whole
 *  traversal surface for a join()-built path. */
export function assertSafeSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)} (no path separators or '..')`);
  }
}

export function projectPath(vaultRoot: string, project: string): string {
  assertSafeSegment(project, "project name");
  return join(vaultRoot, "projects", project);
}

export function artifactDirectory(type: TemplateType, vaultRoot: string, project: string, structure: Structure): string {
  return join(projectPath(vaultRoot, project), artifactFolder(type, structure));
}
