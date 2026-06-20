import { nextId } from "../../artifacts/id";
import type { TemplateType } from "../../schema/load";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { emitJson, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";

const validTypes = new Set<string>(["prd", "slice", "decision", "doc", "handover"]);

export async function handleNextId(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const type = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");

  if (type === undefined || project === undefined) {
    console.error("usage: wiki next-id <prd|slice|decision|handover> --project <name>");
    return { code: 1 };
  }
  if (!validTypes.has(type)) {
    console.error(`unknown type: ${type}`);
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const id = await nextId(type as TemplateType, vaultRoot, project);
  if (jsonEnabled()) emitJson({ id, type, project });
  else console.log(id);
  return { code: 0 };
}
