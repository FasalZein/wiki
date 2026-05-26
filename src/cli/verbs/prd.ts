import { join } from "node:path";

import {
  DedupBlockedError,
  fieldsForDedupOverride,
  formatDedupBlocked,
  parseDedupOverride,
  QmdError,
  runDedupGate,
  type DedupOverride,
} from "../../artifacts/dedup";
import {
  appendField,
  ArtifactNotFoundError,
  ArtifactValidationError,
  createArtifact,
  readArtifact,
  setField,
  setFields,
} from "../../artifacts/store";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handlePrd(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createPrd(rest);
  }
  if (subverb === "show") {
    return showPrd(rest);
  }
  if (subverb === "set") {
    return setPrd(rest);
  }
  if (subverb === "append") {
    return appendPrd(rest);
  }
  if (subverb === "publish") {
    return transitionPrd(rest, "publish", ["draft"], "ready");
  }
  if (subverb === "close") {
    return transitionPrd(rest, "close", ["ready", "in-progress"], "closed");
  }
  console.error(`unknown prd subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function appendPrd(args: string[]): Promise<CliResult> {
  return updatePrdField(args, "append");
}

async function setPrd(args: string[]): Promise<CliResult> {
  return updatePrdField(args, "set");
}

async function updatePrdField(args: string[], mode: "set" | "append"): Promise<CliResult> {
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
      await appendField({ type: "prd", vaultRoot, project, id, field, value });
    } else {
      await setField({ type: "prd", vaultRoot, project, id, field, value });
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

async function showPrd(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "prd", vaultRoot, project, id });
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

async function createPrd(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "project", "force-new", "related-to", "supersedes"]);
  const project = stringValue(parsed.values, "project");
  const title = stringValue(parsed.values, "title");
  const required = { project, title };
  const missing = Object.entries(required).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }

  if (project === undefined || title === undefined) {
    return { code: 1 };
  }

  const override = parseDedupOverride({
    forceNew: stringValue(parsed.values, "force-new"),
    relatedTo: stringValue(parsed.values, "related-to"),
    supersedes: stringValue(parsed.values, "supersedes"),
  });
  if (typeof override === "string") {
    console.error(override);
    return { code: 1 };
  }

  try {
    const artifact = await createPrdProgrammatic({ title, project, dedupOverride: override });
    console.log(artifact.id);
    console.error(`created ${artifact.id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      console.error(formatDedupBlocked(error));
      return { code: 1 };
    }
    if (error instanceof QmdError || error instanceof ProjectConfigError) {
      console.error(error.message);
      return { code: 10 };
    }
    if (error instanceof ArtifactValidationError || error instanceof ArtifactNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

export async function createPrdProgrammatic(input: { title: string; project: string; dedupOverride?: DedupOverride }) {
  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", input.project);
  await assertProjectStructure(projectPath);
  const override = input.dedupOverride ?? { kind: "none" };
  if (input.dedupOverride !== undefined) {
    if (override.kind === "supersedes") {
      await readArtifact({ type: "prd", vaultRoot, project: input.project, id: override.id });
    }
    const config = await loadProjectConfig(projectPath);
    await runDedupGate({ type: "prd", project: input.project, projectPath, config, query: input.title, override });
  }
  const artifact = await createArtifact({
    type: "prd",
    vaultRoot,
    project: input.project,
    fields: { title: input.title, ...fieldsForDedupOverride(override) },
  });
  if (override.kind === "supersedes") {
    await setFields({
      type: "prd",
      vaultRoot,
      project: input.project,
      id: override.id,
      fields: { status: "superseded", superseded_by: artifact.id },
    });
  }
  return artifact;
}

async function transitionPrd(
  args: string[],
  verb: "publish" | "close",
  allowedFrom: readonly string[],
  targetStatus: string,
): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "prd", vaultRoot, project, id });
    const status = artifact.fields.status;
    if (typeof status !== "string" || !allowedFrom.includes(status)) {
      console.error(`cannot ${verb} ${id} from status ${formatStatus(status)}`);
      return { code: 2 };
    }
    await setField({ type: "prd", vaultRoot, project, id, field: "status", value: targetStatus });
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

function formatStatus(status: unknown): string {
  return typeof status === "string" ? status : "unknown";
}
