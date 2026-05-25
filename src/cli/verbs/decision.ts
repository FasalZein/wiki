import { join } from "node:path";

import { ArtifactNotFoundError, ArtifactValidationError, createArtifact, readArtifact } from "../../artifacts/store";
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
  console.error(`unknown decision subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
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
  const missing = [
    ["project", project],
    ["title", title],
    ["context", context],
    ["decision", decision],
    ["consequences", consequences],
  ].flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
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
