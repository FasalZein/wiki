import { projectPath } from "../../artifacts/paths";
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  relocateArtifact,
} from "../../artifacts/store";
import { DOC_CATEGORIES, isDocCategory, type DocCategory } from "../../artifacts/registry";
import { assertProjectStructure, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
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
  if (!isDocCategory(category)) {
    console.error(`unknown category: ${category}`);
    console.error(`category must be one of: ${DOC_CATEGORIES.join(", ")}`);
    return { code: 1 };
  }
  return relocate(project, id, { category });
}

async function relocate(project: string, id: string, change: { title?: string; category?: DocCategory }): Promise<CliResult> {
  const vaultRoot = await getVaultRoot();
  const projPath = projectPath(vaultRoot, project);
  try {
    await assertProjectStructure(projPath);
    const artifact = await relocateArtifact({ type: "doc", vaultRoot, project, id, ...change });
    console.log(artifact.id);
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
