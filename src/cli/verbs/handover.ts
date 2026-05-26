import { join } from "node:path";

import {
  appendField,
  ArtifactNotFoundError,
  ArtifactValidationError,
  createArtifact,
  readArtifact,
  setField,
} from "../../artifacts/store";
import { assertProjectStructure, loadProjectConfig } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { readSession } from "../../state/session";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";

export async function handleHandover(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createHandover(rest);
  }
  if (subverb === "write") {
    return createHandover(rest);
  }
  if (subverb === "show") {
    return showHandover(rest);
  }
  if (subverb === "set") {
    return setHandover(rest);
  }
  if (subverb === "append") {
    return appendHandover(rest);
  }
  console.error(`unknown handover subverb: ${subverb ?? ""}`.trim());
  console.error(
    "hint: produced/open may be inline strings or one of them may be '-' to read all stdin; active context is not auto-detected yet, pass --active-prd / --active-slice / --decision explicitly. SLICE-011 will lift this.",
  );
  return { code: 1 };
}

async function createHandover(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(
    args,
    [
      "project",
      "phase",
      "next-phase",
      "active-prd",
      "produced",
      "open",
      "active-slice",
      "decision",
      "suggested-skill",
    ],
    ["active-slice", "decision", "suggested-skill"],
  );
  const vaultRoot = await getVaultRoot();
  const explicitProject = stringValue(parsed.values, "project");
  const session = explicitProject === undefined ? await readSessionFromAnyProject(vaultRoot) : await readSessionForProject(vaultRoot, explicitProject);
  const project = explicitProject ?? session?.project;
  const phase = stringValue(parsed.values, "phase") ?? session?.phase;
  const required = { project, phase };
  const missing = Object.entries(required).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }
  if (project === undefined || phase === undefined) {
    return { code: 1 };
  }

  const produced = stringValue(parsed.values, "produced");
  const open = stringValue(parsed.values, "open");
  if (produced === "-" && open === "-") {
    console.error("only one of --produced or --open may read from stdin per invocation");
    return { code: 1 };
  }

  await assertProjectStructure(join(vaultRoot, "projects", project));
  try {
    const explicitSlices = stringListValue(parsed.values["active-slice"]);
    const fields: Record<string, unknown> = {
      phase,
      active_slices: explicitSlices.length > 0 ? explicitSlices : session?.active_slices ?? [],
      decisions_made: stringListValue(parsed.values.decision),
      suggested_skills: stringListValue(parsed.values["suggested-skill"]),
    };
    addStringField(fields, "next_phase", stringValue(parsed.values, "next-phase"));
    addStringField(fields, "active_prd", stringValue(parsed.values, "active-prd") ?? session?.active_prd);
    addStringField(fields, "produced", await stdinOrValue(produced));
    addStringField(fields, "open", await stdinOrValue(open));

    const artifact = await createArtifact({
      type: "handover",
      vaultRoot,
      project,
      fields,
    });
    console.log(artifact.id);
    console.error(`created ${artifact.id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function showHandover(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "handover", vaultRoot, project, id });
    const field = stringValue(parsed.values, "field");
    if (field !== undefined) {
      process.stdout.write(`${formatFieldValue(artifact.fields[field])}\n`);
      return { code: 0 };
    }
    process.stdout.write(artifact.body);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function setHandover(args: string[]): Promise<CliResult> {
  return updateHandoverField(args, "set");
}

async function appendHandover(args: string[]): Promise<CliResult> {
  return updateHandoverField(args, "append");
}

async function updateHandoverField(args: string[], mode: "set" | "append"): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const rawValue = parsed.positionals[1];
  const project = stringValue(parsed.values, "project");
  const field = stringValue(parsed.values, "field");
  if (id === undefined || project === undefined || field === undefined || rawValue === undefined) {
    console.error("missing required field: id, project, field, value");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const value = mode === "set" && rawValue === "-" ? await Bun.stdin.text() : rawValue;
  try {
    if (mode === "append") {
      await appendField({ type: "handover", vaultRoot, project, id, field, value });
    } else {
      await setField({ type: "handover", vaultRoot, project, id, field, value });
    }
    console.error(`updated ${id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError || error instanceof ArtifactValidationError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function stdinOrValue(value: string | undefined): Promise<string | undefined> {
  if (value === "-") {
    return Bun.stdin.text();
  }
  return value;
}

function addStringField(fields: Record<string, unknown>, name: string, value: string | undefined): void {
  if (value !== undefined) {
    fields[name] = value;
  }
}

function stringListValue(value: string | string[] | boolean | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

async function readSessionFromAnyProject(vaultRoot: string) {
  const session = await readSession(process.cwd());
  if (session === null) return null;
  try {
    await assertProjectStructure(join(vaultRoot, "projects", session.project));
    return session;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

async function readSessionForProject(vaultRoot: string, project: string) {
  try {
    const config = await loadProjectConfig(join(vaultRoot, "projects", project));
    return readSession(config.repo);
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("\n");
  }
  if (value === undefined) {
    return "";
  }
  return String(value);
}
