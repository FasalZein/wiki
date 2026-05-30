import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { projectPath } from "../../artifacts/paths";
import { ARTIFACT_FOLDERS, STRUCTURAL_FOLDERS } from "../../artifacts/registry";
import { deployViews } from "../../bootstrap/views";
import { getVaultRoot } from "../../config/vault";
import { ensureObsidian, obsidianCreate } from "../../integrations/obsidian";
import { ensureCollection } from "../../integrations/qmd";
import type { CliResult } from "../dispatch";

export async function handleProject(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createProject(rest);
  }
  console.error(`unknown project subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function createProject(args: string[]): Promise<CliResult> {
  const name = args[0];
  if (name === undefined) {
    console.error("missing project name");
    return { code: 1 };
  }

  await ensureObsidian();
  const vaultRoot = await getVaultRoot();
  const projPath = projectPath(vaultRoot, name);

  // Check if project already exists
  try {
    await stat(projPath);
    console.error(`project already exists: ${name}`);
    return { code: 1 };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    // ENOENT means doesn't exist — proceed
  }

  // Create directory structure
  const dirs = [...ARTIFACT_FOLDERS, ...STRUCTURAL_FOLDERS];
  await Promise.all(dirs.map((dir) => mkdir(join(projPath, dir), { recursive: true })));

  const today = new Date().toISOString().slice(0, 10);

  // Create _project.md
  const projectContent = `---\nproject: ${name}\nstatus: planning\ncreated: ${today}\n---\n# ${name}\n`;
  await obsidianCreate("_project", projectContent, `projects/${name}`);

  // Deploy .base view files
  await deployViews(vaultRoot, name);

  // Try to register QMD collection (best-effort)
  try {
    const qmdCommand = process.env.QMD_COMMAND ?? "qmd";
    await ensureCollection(qmdCommand, name, projPath);
  } catch {
    // QMD not available — proceed without it
  }

  console.error(`created project ${name}`);
  console.log(projPath);
  return { code: 0 };
}
