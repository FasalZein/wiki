/**
 * `wiki schema <type>` (P1.5) — make field names, types, required flags, and
 * enum values discoverable from the CLI, instead of grepping a template body's
 * INPUT(select(...)) widget or triggering a validation error to learn them.
 *
 * SLICE-0118: the positional also accepts a bucket/leaf name in the section tree
 * (e.g. `architecture`), resolving to its section's template and surfacing the
 * bucket's config-declared `criteria`.
 */

import { loadKind } from "../../artifacts/body";
import { loadStructure, type Structure } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand } from "../parse";

export async function handleSchema(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const name = parsed.positionals[0];
  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  const resolved = name === undefined ? undefined : resolveSchemaTarget(structure, name);
  if (resolved === undefined) {
    const valid = [...new Set([...Object.keys(structure.kinds), ...bucketNames(structure)])];
    const message = `usage: wiki schema <${valid.join("|")}>`;
    if (jsonEnabled()) emitJsonError({ error: message });
    else console.error(message);
    return { code: 1 };
  }

  const kind = await loadKind(resolved.template, vaultRoot);
  const fields = kind.schema.fields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.auto === true ? { auto: true } : {}),
    ...(field.constraints.values !== undefined ? { values: field.constraints.values } : {}),
  }));

  // BUG-E (ADR-0044): the create-time structure contract is the body's H2
  // sections, derived from the template — not the frontmatter fields. Split into
  // the ones an author supplies via --body (authorable) and the ones the CLI
  // renders from fields (machine-owned), so the contract is discoverable, not
  // learnable only by failing.
  const sections = kind.bodySections();

  if (jsonEnabled()) {
    emitJson({
      type: resolved.name,
      fields,
      bodySections: {
        authorable: sections.authorable.map((h) => `## ${h}`),
        machineOwned: sections.machineOwned.map((m) => ({ heading: `## ${m.heading}`, flags: m.flags })),
      },
      ...(resolved.criteria !== undefined ? { criteria: resolved.criteria } : {}),
    });
    return { code: 0 };
  }

  console.log(`${resolved.name} fields:`);
  for (const field of fields) {
    // BUG-0001 item 6: an `auto` field is filled by the CLI at write time — mark it
    // "auto — omit at create" so agents stop passing e.g. --session-date as required.
    const role = field.auto ? "auto — omit at create" : field.required ? "required" : "optional";
    const flags = [field.type, role].join(", ");
    const values = field.values !== undefined ? `  [${field.values.join(" | ")}]` : "";
    console.log(`  ${field.name.padEnd(20)} ${flags}${values}`);
  }
  console.log("");
  console.log("body sections:");
  console.log(`  authorable (supply via --body): ${sections.authorable.map((h) => `## ${h}`).join(", ") || "(none)"}`);
  if (sections.machineOwned.length > 0) {
    console.log("  machine-owned (do not author):");
    for (const section of sections.machineOwned) {
      const via = section.flags.length > 0 ? ` → set via ${section.flags.join(" / ")}` : "";
      console.log(`    ## ${section.heading}${via}`);
    }
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
  const kind = structure.kinds[name];
  if (kind !== undefined) return { name, template: name, ...(kind.criteria !== undefined ? { criteria: kind.criteria } : {}) };
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
