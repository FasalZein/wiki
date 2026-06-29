import { nextId } from "../../artifacts/id";
import { DEFAULT_STRUCTURE, loadStructure } from "../../artifacts/registry";
import type { TemplateType } from "../../schema/load";
import { getVaultRoot } from "../../config/vault";
import { projectExists } from "../../config/project";
import type { CliResult } from "../dispatch";
import { emitJson, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";

export async function handleNextId(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const type = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");

  if (type === undefined || project === undefined) {
    console.error(`usage: wiki next-id <${Object.keys(DEFAULT_STRUCTURE.kinds).join("|")}> --project <name>`);
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  if (structure.kinds[type] === undefined) {
    console.error(`unknown type: ${type}`);
    return { code: 1 };
  }
  // Guard a mistyped project: an absent project dir otherwise silently returns
  // <PREFIX>-0001 (the id IS correct for an empty project, but the user likely
  // fat-fingered the name). Fail clearly instead.
  if (!(await projectExists(vaultRoot, project))) {
    console.error(`project '${project}' not found — create it with: wiki project create ${project}`);
    return { code: 1 };
  }
  const id = await nextId(type as TemplateType, vaultRoot, project, structure);
  if (jsonEnabled()) emitJson({ id, type, project });
  else console.log(id);
  return { code: 0 };
}
