import { projectPath } from "../../artifacts/paths";
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  relocateArtifact,
} from "../../artifacts/store";
import { loadStructure } from "../../artifacts/registry";
import { assertProjectStructure, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { emitJson, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";
import { unknownMessage } from "../usage";
import type { CliResult } from "../dispatch";

export async function handleDoc(args: string[]): Promise<CliResult> {
  const [sub, ...rest] = args;
  if (sub === "retitle") return retitleDoc(rest);
  if (sub === "recategorize") return recategorizeDoc(rest);
  console.error(unknownMessage("doc subcommand", sub ?? "", ["retitle", "recategorize"]));
  return { code: 1 };
}

async function retitleDoc(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "title"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  const title = stringValue(parsed.values, "title");
  if (id === undefined || project === undefined || title === undefined) {
    console.error("missing required field: <DOC-NNNN>, --project, --title");
    return { code: 1 };
  }
  return relocate(project, id, { title });
}

async function recategorizeDoc(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "category"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  const category = stringValue(parsed.values, "category");
  if (id === undefined || project === undefined || category === undefined) {
    console.error("missing required field: <DOC-NNNN>, --project, --category");
    return { code: 1 };
  }
  return relocate(project, id, { bucket: category });
}

async function relocate(project: string, id: string, change: { title?: string; bucket?: string }): Promise<CliResult> {
  const vaultRoot = await getVaultRoot();
  const projPath = projectPath(vaultRoot, project);
  try {
    const structure = await loadStructure(vaultRoot);
    const type = structure.typeForId(id);
    if (type === undefined) {
      console.error(`unknown id (no registered kind for prefix): ${id}`);
      return { code: 1 };
    }
    // Validate a recategorize target against the section's declared buckets so
    // an unknown category fails with the category vocabulary, before any move.
    if (change.bucket !== undefined) {
      const section = structure.sections.find((s) => s.name === type);
      if (section === undefined || section.tree === "leaf") {
        console.error(`recategorize is not applicable: kind '${type}' has no sub-categories in this vault`);
        return { code: 1 };
      }
      const bucketNames = section.buckets.map((bucket) => bucket.name);
      if (!bucketNames.includes(change.bucket)) {
        console.error(`unknown category: ${change.bucket}`);
        console.error(`category must be one of: ${bucketNames.join(", ")}`);
        return { code: 1 };
      }
    }
    await assertProjectStructure(projPath, structure);
    const artifact = await relocateArtifact({ type, vaultRoot, project, id, ...change }, structure);
    if (jsonEnabled()) emitJson({ id: artifact.id, path: artifact.path });
    else console.log(artifact.id);
    console.error(`updated ${artifact.id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError || error instanceof ArtifactValidationError) {
      console.error(error.message);
      return { code: 1 };
    }
    if (error instanceof ProjectConfigError) {
      console.error(error.message);
      return { code: 10 };
    }
    throw error;
  }
}
