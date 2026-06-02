import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { projectPath } from "../../artifacts/paths";
import { ARTIFACT_FOLDERS, STRUCTURAL_FOLDERS } from "../../artifacts/registry";
import { deployViews } from "../../bootstrap/views";
import { listProjects } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { ensureObsidian, obsidianCreate } from "../../integrations/obsidian";
import { ensureCollection } from "../../integrations/qmd";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";
import { unknownMessage } from "../usage";

export async function handleProject(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createProject(rest);
  }
  if (subverb === "list") {
    return listProjectsCommand();
  }
  console.error(unknownMessage("project subverb", subverb ?? "", ["create", "list"]));
  return { code: 1 };
}

async function listProjectsCommand(): Promise<CliResult> {
  const vaultRoot = await getVaultRoot();
  const projects = await listProjects(vaultRoot);
  if (projects.length === 0) {
    console.log("No projects yet. Create one with: wiki project create <name>");
    return { code: 0 };
  }
  for (const project of projects) {
    console.log(project);
  }
  return { code: 0 };
}

async function createProject(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["repo", "test-command"]);
  const name = parsed.positionals[0];
  if (name === undefined) {
    console.error("missing project name");
    return { code: 1 };
  }
  // A project needs repo + test_command to be usable by status/red/green; default
  // them (repo = cwd, the usual case; test_command = bun test) so the project is
  // complete on creation rather than failing the skill's first command. Both are
  // overridable via flags and editable later in _project.md.
  const repo = stringValue(parsed.values, "repo") ?? process.cwd();
  const testCommand = stringValue(parsed.values, "test-command") ?? "bun test";

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

  // Create _project.md (complete: repo + test_command so status/red/green work immediately)
  const projectContent = `---\nproject: ${name}\nstatus: planning\ncreated: ${today}\nrepo: ${repo}\ntest_command: ${testCommand}\n---\n# ${name}\n`;
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

  console.error(`created project ${name} (repo: ${repo}, test_command: ${testCommand})`);
  console.error(`edit projects/${name}/_project.md to change repo/test_command; then: wiki session start --project ${name}`);
  console.log(projPath);
  return { code: 0 };
}
