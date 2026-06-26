import { nextId } from "../../artifacts/id";
import { ARTIFACTS, loadStructure } from "../../artifacts/registry";
import type { TemplateType } from "../../schema/load";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { emitJson, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";

export async function handleNextId(args: string[]): Promise<CliResult> {
  const validTypes = Object.keys(ARTIFACTS);
  const parsed = parseCommand(args, ["project"]);
  const type = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");

  if (type === undefined || project === undefined) {
    console.error(`usage: wiki next-id <${validTypes.join("|")}> --project <name>`);
    return { code: 1 };
  }
  if (!validTypes.includes(type)) {
    console.error(`unknown type: ${type}`);
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  const id = await nextId(type as TemplateType, vaultRoot, project, structure);
  if (jsonEnabled()) emitJson({ id, type, project });
  else console.log(id);
  return { code: 0 };
}
