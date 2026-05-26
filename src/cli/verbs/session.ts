import { join } from "node:path";

import { loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { clearSession, readSession, sessionPath, updateSession, writeSession, type SessionState } from "../../state/session";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";

const sessionFields = new Set(["project", "active_prd", "active_slices", "phase", "notes"]);

export async function handleSession(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "start") return startSession(rest);
  if (subverb === "set") return setSession(rest);
  if (subverb === "show") return showSession(rest);
  if (subverb === "clear") return clearCurrentSession(rest);
  console.error(`unknown session subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function startSession(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "active-prd", "active-slice", "phase"], ["active-slice"]);
  const project = stringValue(parsed.values, "project");
  if (project === undefined) {
    console.error("missing required field: project");
    return { code: 1 };
  }
  const repo = await repoForProject(project);
  const session = await writeSession(repo, {
    project,
    active_prd: stringValue(parsed.values, "active-prd"),
    active_slices: stringListValue(parsed.values["active-slice"]),
    phase: stringValue(parsed.values, "phase") ?? "ad-hoc",
  });
  console.log(sessionPath(repo));
  console.error(`session started for ${session.project}`);
  return { code: 0 };
}

async function setSession(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const project = stringValue(parsed.values, "project");
  const field = stringValue(parsed.values, "field");
  const rawValue = parsed.positionals[0];
  if (field === undefined || rawValue === undefined) {
    console.error("missing required field: field, value");
    return { code: 1 };
  }
  const normalizedField = field.replaceAll("-", "_");
  if (!sessionFields.has(normalizedField)) {
    console.error("field must be one of: project, active_prd, active_slices, phase, notes");
    return { code: 1 };
  }
  const repo = project === undefined ? process.cwd() : await repoForProject(project);
  const raw = rawValue === "-" ? await Bun.stdin.text() : rawValue;
  const patch: Partial<Omit<SessionState, "updated">> = {};
  if (normalizedField === "active_slices") {
    patch.active_slices = raw.length === 0 ? [] : raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  } else if (normalizedField === "project") {
    patch.project = raw;
  } else if (normalizedField === "active_prd") {
    patch.active_prd = raw;
  } else if (normalizedField === "phase") {
    patch.phase = raw;
  } else {
    patch.notes = raw;
  }
  await updateSession(repo, patch);
  console.error("session updated");
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

function stringListValue(value: string | string[] | boolean | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}
