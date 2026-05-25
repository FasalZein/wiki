import { stat } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactValidationError, createArtifact } from "../../artifacts/store";
import { assertProjectStructure } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";

export async function handleSlice(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createSlice(rest);
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
