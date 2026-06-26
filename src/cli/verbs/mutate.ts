/**
 * First-class, validated field mutation verbs (P1.2) so an agent never hand-edits
 * an artifact for a status change, a `blocked_by` edit, or a supersede. All wrap
 * the internal store writers (setField / supersedeArtifact), which validate
 * against the schema before writing.
 */

import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  readArtifact,
  relocateArtifact,
  setField,
  supersedeArtifact,
} from "../../artifacts/store";
import { typeForId } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand, type ParsedCommand } from "../parse";
import { resolveProject } from "../resolve-project";

type Target = { type: TemplateType; vaultRoot: string; project: string; id: string };

/** wiki set <id> <field> <value...> — never comma-splits; coerces by schema type. */
export async function handleSet(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const [id, field, ...values] = parsed.positionals;
  if (id === undefined || field === undefined || values.length === 0) {
    return fail("usage: wiki set <id> <field> <value...> [--project <name>]");
  }
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);

  const coerced = await coerceValue(target.type, field, values);
  if (typeof coerced === "object" && coerced !== null && "error" in coerced) return fail((coerced as { error: string }).error);

  return run(target, () => setField({ ...target, field, value: (coerced as { value: unknown }).value }), (artifact) => ({
    id: target.id,
    field,
    value: artifact.fields[field] ?? null,
  }), `set ${field} on ${target.id}`);
}

/** wiki block <id> --on <id> [--on <id>...] — auto-wraps bare ids as [[..]] wikilinks. */
export async function handleBlock(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "on"], ["on"]);
  const id = parsed.positionals[0];
  const on = listValue(parsed.values.on);
  if (id === undefined || on.length === 0) {
    return fail("usage: wiki block <id> --on <id> [--on <id>...] [--project <name>]");
  }
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);

  const wrapped = on.map((value) => (/^\[\[.*\]\]$/.test(value) ? value : `[[${value}]]`));
  return run(target, () => setField({ ...target, field: "blocked_by", value: wrapped }), () => ({
    id: target.id,
    blocked_by: wrapped,
  }), `${target.id} blocked_by ${wrapped.join(", ")}`);
}

/** wiki supersede <oldId> --by <newId> — standalone supersede for existing artifacts. */
export async function handleSupersede(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "by"]);
  const oldId = parsed.positionals[0];
  const by = typeof parsed.values.by === "string" ? parsed.values.by : undefined;
  if (oldId === undefined || by === undefined) {
    return fail("usage: wiki supersede <oldId> --by <newId> [--project <name>]");
  }
  const target = await resolveTarget(oldId, parsed);
  if (typeof target === "string") return fail(target);

  try {
    await readArtifact({ type: target.type, vaultRoot: target.vaultRoot, project: target.project, id: by });
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return fail(`superseding artifact not found: ${by}`);
    throw error;
  }
  return run(target, () => supersedeArtifact({ ...target, by }), (artifact) => ({
    id: target.id,
    status: artifact.fields.status ?? null,
    superseded_by: by,
  }), `${target.id} superseded by ${by}`);
}

/** wiki path <id> — print the absolute file path (resolve-by-id without globbing, P1.4). */export async function handlePath(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const id = parsed.positionals[0];
  if (id === undefined) return fail("usage: wiki path <id> [--project <name>]");
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);
  try {
    const artifact = await readArtifact(target);
    if (jsonEnabled()) emitJson({ id: target.id, path: artifact.path });
    else console.log(artifact.path);
    return { code: 0 };
  } catch (error) {
    return handleError(error);
  }
}

/** wiki retitle <id> --title <t> — link-preserving retitle for any kind (id kept, file re-slugged). */
export async function handleRetitle(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "title"]);
  const id = parsed.positionals[0];
  const title = typeof parsed.values.title === "string" ? parsed.values.title : undefined;
  if (id === undefined || title === undefined) {
    return fail("usage: wiki retitle <id> --title <title> [--project <name>]");
  }
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);
  return run(target, () => relocateArtifact({ ...target, title }), (artifact) => ({
    id: target.id,
    title: artifact.fields.title ?? null,
    path: (artifact as { path?: string }).path ?? null,
  }), `retitled ${target.id}`);
}

async function resolveTarget(id: string, parsed: ParsedCommand): Promise<Target | string> {
  const type = typeForId(id);
  if (type === undefined) return `cannot infer artifact type from id: ${id}`;
  const project = await resolveProject(parsed);
  if (project === undefined) return "no project: pass --project <name> or run from a linked repo";
  const vaultRoot = await getVaultRoot();
  return { type, vaultRoot, project, id };
}

/** Coerce raw CLI string args to the field's schema type (booleans, integers, lists). */
async function coerceValue(type: TemplateType, field: string, values: string[]): Promise<{ value: unknown } | { error: string }> {
  const schema = await loadTemplate(type);
  const def = schema.fields.find((candidate) => candidate.name === field);
  if (def === undefined) return { error: `unknown field for ${type}: ${field}` };
  if (def.type === "list" || def.type === "link_list") return { value: values };
  if (values.length !== 1) return { error: `field ${field} takes a single value` };
  const raw = values[0]!;
  if (def.type === "boolean") {
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    return { error: `field ${field} expects true|false` };
  }
  if (def.type === "integer") {
    const n = Number(raw);
    if (!Number.isInteger(n)) return { error: `field ${field} expects an integer` };
    return { value: n };
  }
  return { value: raw };
}

async function run(
  target: Target,
  write: () => Promise<{ fields: Record<string, unknown>; path?: string }>,
  json: (artifact: { fields: Record<string, unknown>; path?: string }) => Record<string, unknown>,
  human: string,
): Promise<CliResult> {
  try {
    const artifact = await write();
    if (jsonEnabled()) emitJson(json(artifact));
    else console.log(human);
    return { code: 0 };
  } catch (error) {
    return handleError(error);
  }
}

function handleError(error: unknown): CliResult {
  if (error instanceof ArtifactValidationError) {
    const first = error.errors[0];
    return fail(error.message, first === undefined ? {} : { field: first.field, expected: first.expected });
  }
  if (error instanceof ArtifactNotFoundError) return fail(error.message);
  throw error;
}

function fail(message: string, extra: Record<string, unknown> = {}): CliResult {
  if (jsonEnabled()) emitJsonError({ error: message, ...extra });
  else console.error(message);
  return { code: 1 };
}

function listValue(value: string | string[] | boolean | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}
