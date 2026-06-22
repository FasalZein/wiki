import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { projectPath } from "../../artifacts/paths";
import { ARTIFACT_FOLDERS } from "../../artifacts/registry";
import { listProjects, loadProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { readLinkedProject } from "../repo-link";
import { emitJson, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";

const RECENT_LIMIT = 10;

export async function handleStatus(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const explicit = stringValue(parsed.values, "project");
  const vaultRoot = await getVaultRoot();

  let project = explicit;
  if (project === undefined) {
    // No --project: prefer the repo's linked project; otherwise summarize the vault.
    const linked = await readLinkedProject(process.cwd());
    if (linked === null) return summarizeVault(vaultRoot);
    project = linked;
  }

  const projPath = projectPath(vaultRoot, project);
  try {
    await loadProjectConfig(projPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(await projectErrorMessage(vaultRoot, project));
      return { code: 10 };
    }
    throw error;
  }

  const recent = await recentArtifacts(vaultRoot, projPath);

  if (jsonEnabled()) {
    emitJson({ project, recent: recent.map((r) => r.rel) });
    return { code: 0 };
  }

  console.log(`Project: ${project}`);
  if (recent.length === 0) {
    console.log("No artifacts yet. Create one with: wiki create <type> --project " + project);
    return { code: 0 };
  }
  console.log(`Recent artifacts (${recent.length}):`);
  for (const r of recent) {
    console.log(`  ${r.rel}`);
  }
  return { code: 0 };
}

/** The most-recently-modified artifact files across the project's kind folders. */
async function recentArtifacts(vaultRoot: string, projectPath: string): Promise<{ rel: string; mtime: number }[]> {
  const files: { rel: string; mtime: number }[] = [];
  for (const folder of ARTIFACT_FOLDERS) {
    const dir = join(projectPath, folder);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const full = join(entry.parentPath, entry.name);
      const stats = await stat(full);
      files.push({ rel: relative(vaultRoot, full), mtime: stats.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_LIMIT);
}

/** Vault-wide summary: list every project. */
async function summarizeVault(vaultRoot: string): Promise<CliResult> {
  const projects = await listProjects(vaultRoot);
  if (projects.length === 0) {
    console.log("No projects yet. Create one with: wiki project create <name>");
    return { code: 0 };
  }
  console.log(`Vault: ${projects.length} project${projects.length === 1 ? "" : "s"}`);
  for (const project of projects) {
    console.log(`  ${project}`);
  }
  console.log("Run 'wiki status --project <name>' for detail.");
  return { code: 0 };
}
