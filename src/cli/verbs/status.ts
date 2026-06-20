import { join } from "node:path";

import { listProjects, loadProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { readSession } from "../../state/session";
import { writePhaseDocToStdout } from "../phase-docs";
import { nextActionForPhase } from "../guidance";
import { emitJson, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";
import { booleanValue, parseCommand, stringValue } from "../parse";

export async function handleStatus(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["with-doc"]);
  const project = stringValue(parsed.values, "project");
  let repo: string;
  if (project === undefined) {
    // No --project: prefer the current repo's session; otherwise summarize the vault (ADR-0027).
    const cwdSession = await readSession(process.cwd());
    if (cwdSession === null) {
      return summarizeVault(await getVaultRoot());
    }
    repo = process.cwd();
  } else {
    const vaultRoot = await getVaultRoot();
    try {
      repo = (await loadProjectConfig(join(vaultRoot, "projects", project), { requireLifecycle: true })).repo;
    } catch (error) {
      if (error instanceof ProjectConfigError) {
        console.error(await projectErrorMessage(vaultRoot, project, error));
        return { code: 10 };
      }
      throw error;
    }
  }
  const session = await readSession(repo);
  if (session === null) {
    const label = project === undefined ? "current repo" : `project ${project}`;
    console.log(`No active session for ${label}. Run wiki session start --project <project>.`);
    return { code: 0 };
  }

  const nextCommand = nextActionForPhase(session.phase, {
    project: session.project,
    slice: session.active_slices[0] ?? "<slice>",
    prd: session.active_prd ?? undefined,
  });

  if (jsonEnabled()) {
    emitJson({
      project: session.project,
      phase: session.phase,
      active_prd: session.active_prd ?? null,
      active_slices: session.active_slices,
      next_command: nextCommand,
    });
    return { code: 0 };
  }

  console.log(`Project: ${session.project}`);
  console.log(`Phase: ${session.phase}`);
  console.log(`Active PRD: ${session.active_prd ?? "(none)"}`);
  console.log(`Active slices: ${session.active_slices.length > 0 ? session.active_slices.join(", ") : "(none)"}`);
  console.log(`Next: ${nextCommand}`);

  if (booleanValue(parsed.values, "with-doc")) {
    if (!writePhaseDocToStdout(session.phase)) {
      console.error(`no phase guidance for: ${session.phase}`);
      return { code: 1 };
    }
  }
  return { code: 0 };
}

/** Vault-wide summary: every project, its repo, and its active session phase if any. */
async function summarizeVault(vaultRoot: string): Promise<CliResult> {
  const projects = await listProjects(vaultRoot);
  if (projects.length === 0) {
    console.log("No projects yet. Create one with: wiki project create <name>");
    return { code: 0 };
  }
  console.log(`Vault: ${projects.length} project${projects.length === 1 ? "" : "s"}`);
  for (const project of projects) {
    let phase = "";
    try {
      const config = await loadProjectConfig(join(vaultRoot, "projects", project), { requireLifecycle: true });
      const session = await readSession(config.repo);
      phase = session === null ? "no session" : `${session.phase}${session.active_slices[0] ? ` (${session.active_slices[0]})` : ""}`;
    } catch (error) {
      phase = error instanceof ProjectConfigError ? "incomplete _project.md" : "unknown";
    }
    console.log(`  ${project} — ${phase}`);
  }
  console.log("Run 'wiki status --project <name>' for detail.");
  return { code: 0 };
}
