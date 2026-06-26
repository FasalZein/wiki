/**
 * `wiki schema <type>` (P1.5) — make field names, types, required flags, and
 * enum values discoverable from the CLI, instead of grepping a template body's
 * INPUT(select(...)) widget or triggering a validation error to learn them.
 */

import { loadStructure } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand } from "../parse";

export async function handleSchema(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const type = parsed.positionals[0];
  const structure = await loadStructure(await getVaultRoot());
  const TYPES = new Set<string>(Object.keys(structure.kinds));
  if (type === undefined || !TYPES.has(type)) {
    const message = `usage: wiki schema <${[...TYPES].join("|")}>`;
    if (jsonEnabled()) emitJsonError({ error: message });
    else console.error(message);
    return { code: 1 };
  }

  const schema = await loadTemplate(type as TemplateType);
  const fields = schema.fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.constraints.values !== undefined ? { values: field.constraints.values } : {}),
  }));

  if (jsonEnabled()) {
    emitJson({ type, fields });
    return { code: 0 };
  }

  console.log(`${type} fields:`);
  for (const field of fields) {
    const flags = [field.type, field.required ? "required" : "optional"].join(", ");
    const values = field.values !== undefined ? `  [${field.values.join(" | ")}]` : "";
    console.log(`  ${field.name.padEnd(20)} ${flags}${values}`);
  }
  return { code: 0 };
}
