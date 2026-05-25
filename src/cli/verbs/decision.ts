import { join } from "node:path";

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
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleDecision(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createDecision(rest);
  }
  if (subverb === "show") {
    return showDecision(rest);
  }
  if (subverb === "set") {
    return setDecision(rest);
  }
  if (subverb === "append") {
    return appendDecision(rest);
  }
  console.error(`unknown decision subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function appendDecision(args: string[]): Promise<CliResult> {
  return updateDecisionField(args, "append");
}

async function setDecision(args: string[]): Promise<CliResult> {
  return updateDecisionField(args, "set");
}

async function updateDecisionField(args: string[], mode: "set" | "append"): Promise<CliResult> {
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
      await appendField({ type: "decision", vaultRoot, project, id, field, value });
    } else {
      await setField({ type: "decision", vaultRoot, project, id, field, value });
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

async function showDecision(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "decision", vaultRoot, project, id });
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

async function createDecision(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "context", "decision", "consequences", "project"]);
  const project = stringValue(parsed.values, "project");
  const title = stringValue(parsed.values, "title");
  const context = stringValue(parsed.values, "context");
  const decision = stringValue(parsed.values, "decision");
  const consequences = stringValue(parsed.values, "consequences");
  const required = { project, title, context, decision, consequences };
  const missing = Object.entries(required).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }

  if (
    project === undefined ||
    title === undefined ||
    context === undefined ||
    decision === undefined ||
    consequences === undefined
  ) {
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  await assertProjectStructure(join(vaultRoot, "projects", project));
  try {
    const artifact = await createArtifact({
      type: "decision",
      vaultRoot,
      project,
      fields: { title, context, decision, consequences },
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
