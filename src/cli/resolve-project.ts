/**
 * Shared project resolution for CLI verbs (the DOC-0003 project-resolver seam):
 * an explicit --project wins, otherwise fall back to the project the repo is
 * linked to via its pointer block, validated against the vault. Verbs that
 * support a linked repo share this one resolver instead of hard-requiring --project.
 */

import { join } from "node:path";

import { assertProjectStructure } from "../config/project";
import { getVaultRoot } from "../config/vault";
import { readLinkedProject } from "./repo-link";
import { stringValue, type ParsedCommand } from "./parse";

/** The repo's linked project at cwd, or null when absent or pointing at a missing vault project. */
export async function linkedProjectFromCwd(): Promise<string | null> {
  const project = await readLinkedProject(process.cwd());
  if (project === null) return null;
  try {
    const vaultRoot = await getVaultRoot();
    await assertProjectStructure(join(vaultRoot, "projects", project));
    return project;
  } catch {
    return null;
  }
}

/**
 * Resolve the target project for a verb: an explicit --project wins, otherwise
 * the project the repo is linked to. Returns undefined when neither an explicit
 * flag nor a valid linked repo is present.
 */
export async function resolveProject(parsed: ParsedCommand): Promise<string | undefined> {
  const explicit = stringValue(parsed.values, "project");
  if (explicit !== undefined) return explicit;
  return (await linkedProjectFromCwd()) ?? undefined;
}
