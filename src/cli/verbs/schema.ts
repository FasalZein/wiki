/**
 * `wiki schema <type>` (P1.5) — make field names, types, required flags, and
 * enum values discoverable from the CLI, instead of grepping a template body's
 * INPUT(select(...)) widget or triggering a validation error to learn them.
 *
 * SLICE-0118: the positional also accepts a bucket/leaf name in the section tree
 * (e.g. `architecture`), resolving to its section's template and surfacing the
 * bucket's config-declared `criteria`.
 */

import { loadStructure, type Structure } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand } from "../parse";

export async function handleSchema(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const name = parsed.positionals[0];
  const structure = await loadStructure(await getVaultRoot());
  const resolved = name === undefined ? undefined : resolveSchemaTarget(structure, name);
  if (resolved === undefined) {
    const valid = [...new Set([...Object.keys(structure.kinds), ...bucketNames(structure)])];
    const message = `usage: wiki schema <${valid.join("|")}>`;
    if (jsonEnabled()) emitJsonError({ error: message });
    else console.error(message);
    return { code: 1 };
  }

  const schema = await loadTemplate(resolved.template);
  const fields = schema.fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.constraints.values !== undefined ? { values: field.constraints.values } : {}),
  }));

  if (jsonEnabled()) {
    emitJson({ type: resolved.name, fields, ...(resolved.criteria !== undefined ? { criteria: resolved.criteria } : {}) });
    return { code: 0 };
  }

  console.log(`${resolved.name} fields:`);
  for (const field of fields) {
    const flags = [field.type, field.required ? "required" : "optional"].join(", ");
    const values = field.values !== undefined ? `  [${field.values.join(" | ")}]` : "";
    console.log(`  ${field.name.padEnd(20)} ${flags}${values}`);
  }
  if (resolved.criteria !== undefined) {
    console.log("");
    console.log(`criteria: ${resolved.criteria}`);
  }
  return { code: 0 };
}

/** Resolve a `wiki schema` positional to a template + display name, accepting a
 *  kind name or a bucket/leaf name. A bucket also carries its criteria. */
function resolveSchemaTarget(
  structure: Structure,
  name: string,
): { name: string; template: TemplateType; criteria?: string } | undefined {
  if (structure.kinds[name] !== undefined) return { name, template: name };
  const bucket = structure.bucketFor(name);
  if (bucket !== undefined) {
    return {
      name,
      template: bucket.bucket.template,
      ...(bucket.bucket.criteria !== undefined ? { criteria: bucket.bucket.criteria } : {}),
    };
  }
  return undefined;
}

/** Every branch-section bucket name (leaf buckets equal their kind name, already
 *  listed via structure.kinds). */
function bucketNames(structure: Structure): string[] {
  return structure.sections.filter((s) => s.tree === "branch").flatMap((s) => s.buckets.map((b) => b.name));
}
