import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { clearSession, readSession, sessionPath, writeSession } from "../../state/session";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";
import { unknownMessage } from "../usage";

export async function handleSession(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "start") return startSession(rest);
  if (subverb === "show") return showSession(rest);
  if (subverb === "clear") return clearCurrentSession(rest);
  console.error(unknownMessage("session subverb", subverb ?? "", ["start", "show", "clear"]));
  return { code: 1 };
}

async function startSession(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const project = stringValue(parsed.values, "project");
  if (project === undefined) {
    console.error("missing required field: project");
    return { code: 1 };
  }
  const repo = await repoForProject(project);
  await ensureWikiGitignored(repo);
  const session = await writeSession(repo, { project });
  console.log(sessionPath(repo));
  console.error(`session started for ${session.project}`);
  return { code: 0 };
}

async function showSession(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const project = stringValue(parsed.values, "project");
  const repo = project === undefined ? process.cwd() : await repoForProject(project);
  const session = await readSession(repo);
  if (session === null) {
    console.log("No active session. Start one with wiki session start --project <project>.");
    return { code: 0 };
  }
  process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  return { code: 0 };
}

async function clearCurrentSession(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const project = stringValue(parsed.values, "project");
  const repo = project === undefined ? process.cwd() : await repoForProject(project);
  await clearSession(repo);
  console.error("session cleared");
  return { code: 0 };
}

/**
 * Ensure the repo's .gitignore ignores the whole .wiki/ folder. wiki is single-user
 * tooling, so its repo-local state (sessions, gate logs) should never be committed.
 * Best-effort: failures (e.g. unwritable dir) must not block starting a session.
 */
async function ensureWikiGitignored(repo: string): Promise<void> {
  try {
    const gitignorePath = join(repo, ".gitignore");
    const existing = await readFile(gitignorePath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    const ignored = existing.split("\n").some((line) => line.trim() === ".wiki/" || line.trim() === ".wiki");
    if (ignored) return;
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${existing}${prefix}.wiki/\n`);
  } catch {
    // best-effort; never block the session on gitignore maintenance
  }
}

async function repoForProject(project: string): Promise<string> {
  const vaultRoot = await getVaultRoot();
  try {
    const config = await loadProjectConfig(join(vaultRoot, "projects", project));
    return config.repo;
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(error.message);
      process.exitCode = 10;
    }
    throw error;
  }
}
