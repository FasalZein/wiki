import { stat } from "node:fs/promises";
import { join } from "node:path";

import { decideTransition } from "../../artifacts/transitions";
import {
  appendField,
  ArtifactNotFoundError,
  ArtifactValidationError,
  createArtifact,
  readArtifact,
  setField,
} from "../../artifacts/store";
import { assertProjectStructure } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";

export async function handleSlice(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createSlice(rest);
  }
  if (subverb === "show") {
    return showSlice(rest);
  }
  if (subverb === "set") {
    return setSlice(rest);
  }
  if (subverb === "append") {
    return appendSlice(rest);
  }
  if (subverb === "red") {
    return redSlice(rest);
  }
  console.error(`unknown slice subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function createSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "project", "parent-prd"]);
  const project = stringValue(parsed.values, "project");
  const title = stringValue(parsed.values, "title");
  const parentPrd = stringValue(parsed.values, "parent-prd");
  const required = { project, title, "parent-prd": parentPrd };
  const missing = Object.entries(required).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }

  if (project === undefined || title === undefined || parentPrd === undefined) {
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  await assertProjectStructure(join(vaultRoot, "projects", project));
  const parentPrdPath = join(vaultRoot, "projects", project, "prds", `${parentPrd}.md`);
  if (!(await fileExists(parentPrdPath))) {
    console.error(`parent PRD not found: ${parentPrd}`);
    return { code: 1 };
  }

  try {
    const artifact = await createArtifact({
      type: "slice",
      vaultRoot,
      project,
      fields: { title, parent_prd: parentPrd, acceptance: [] },
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

async function appendSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const value = parsed.positionals[1];
  const project = stringValue(parsed.values, "project");
  const field = stringValue(parsed.values, "field");
  if (id === undefined || project === undefined || field === undefined || value === undefined) {
    console.error("missing required field: id, project, field, value");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    await appendField({ type: "slice", vaultRoot, project, id, field, value });
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

async function setSlice(args: string[]): Promise<CliResult> {
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
  const value = rawValue === "-" ? await Bun.stdin.text() : rawValue;
  try {
    await setField({ type: "slice", vaultRoot, project, id, field, value });
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

async function redSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "slice", vaultRoot, project, id });
    const decision = decideTransition({ id, verb: "red", status: artifact.fields.status });
    if (!decision.ok) {
      console.error(decision.reason);
      return { code: decision.exitCode };
    }
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function showSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "slice", vaultRoot, project, id });
    const field = stringValue(parsed.values, "field");
    if (field !== undefined) {
      const value = artifact.fields[field];
      process.stdout.write(`${formatFieldValue(value)}\n`);
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

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("\n");
  }
  if (value === undefined) {
    return "";
  }
  return String(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
