import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";

import { projectPath } from "../../artifacts/paths";
import { ARTIFACT_FOLDERS, STRUCTURAL_FOLDERS } from "../../artifacts/registry";
import { deployViews } from "../../bootstrap/views";
import { listProjects } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { ensureObsidian, obsidianCreate, obsidianPropertySet } from "../../integrations/obsidian";
import { ensureCollection } from "../../integrations/qmd";
import { stampRepo } from "../repo-link";
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
  if (subverb === "link") {
    return linkProject(rest);
  }
  console.error(unknownMessage("project subverb", subverb ?? "", ["create", "list", "link"]));
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

async function linkProject(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["repo", "project"]);
  const repoArg = stringValue(parsed.values, "repo");
  const projectName = stringValue(parsed.values, "project");

  if (repoArg === undefined) {
    console.error("missing required flag: --repo <path>");
    return { code: 1 };
  }
  if (projectName === undefined) {
    console.error("missing required flag: --project <name>");
    return { code: 1 };
  }

  const repoDir = resolve(repoArg);
  const vaultRoot = await getVaultRoot();
  const projDir = join(vaultRoot, "projects", projectName);
  const projectMdPath = join(projDir, "_project.md");

  // Verify project exists
  try {
    await stat(projectMdPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`project '${projectName}' not found — create it with: wiki project create ${projectName}`);
      return { code: 1 };
    }
    throw error;
  }

  // Stamp the pointer block into AGENTS.md and CLAUDE.md
  await stampRepo(repoDir, projectName);

  // Record repo in _project.md linked_repos list (idempotent). Vault writes go
  // through the Obsidian CLI (ADR-0017), never raw FS.
  const raw = await readFile(projectMdPath, "utf8");
  const parsed2 = matter(raw);
  const existing: string[] = Array.isArray(parsed2.data.linked_repos) ? parsed2.data.linked_repos : [];
  if (!existing.includes(repoDir)) {
    existing.push(repoDir);
    await obsidianPropertySet(`projects/${projectName}/_project.md`, "linked_repos", existing.join(","), "list");
  }

  console.error(`linked repo ${repoDir} to project ${projectName}`);
  console.log(repoDir);
  return { code: 0 };
}
