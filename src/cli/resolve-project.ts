/**
 * Shared project resolution for CLI verbs (the DOC-0003 project-resolver seam):
 * an explicit --project wins, otherwise fall back to the project of the repo's
 * active session, validated against the vault. Verbs that support sessionless
 * use share this one resolver instead of each hard-requiring --project.
 */

import { join } from "node:path";

import { assertProjectStructure } from "../config/project";
import { getVaultRoot } from "../config/vault";
import { readSession } from "../state/session";
import { stringValue, type ParsedCommand } from "./parse";

/** The repo session at cwd, or null when absent or pointing at a missing vault project. */
export async function readSessionFromCwd() {
  const session = await readSession(process.cwd());
  if (session === null) return null;
  try {
    const vaultRoot = await getVaultRoot();
    await assertProjectStructure(join(vaultRoot, "projects", session.project));
    return session;
  } catch {
    return null;
  }
}

/**
 * Resolve the target project for a verb: an explicit --project wins, otherwise
 * the project of the repo's active session. Returns undefined when neither an
 * explicit flag nor a valid repo session is present.
 */
export async function resolveProject(parsed: ParsedCommand): Promise<string | undefined> {
  const explicit = stringValue(parsed.values, "project");
  if (explicit !== undefined) return explicit;
  return (await readSessionFromCwd())?.project;
}
