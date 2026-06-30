/**
 * First-class, validated field mutation verbs (P1.2) so an agent never hand-edits
 * an artifact for a status change, a `blocked_by` edit, or a supersede. All wrap
 * the internal store writers (setField / supersedeArtifact), which validate
 * against the schema before writing.
 */

import { buildIdIndex } from "../../artifacts/id-index";
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  readArtifact,
  relocateArtifact,
  scrubInboundLinks,
  type ScrubResult,
  setField,
  supersedeArtifact,
} from "../../artifacts/store";
import { rm } from "node:fs/promises";
import { inboundReferences } from "../../artifacts/references";
import { loadStructure, type Structure } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { booleanValue, parseCommand, type ParsedCommand } from "../parse";
import { resolveProject } from "../resolve-project";

type Target = { type: TemplateType; vaultRoot: string; project: string; id: string; structure: Structure };

/**
 * wiki set <id> <field> <value...> — full-replace; never comma-splits; coerces by schema type.
 * For list/link_list fields, --add/--remove/--clear do an additive read-merge-validate-write
 * so a single edit never silently overwrites the rest of the list (PRD-0015 item 10).
 * Bare `set` stays full-replace. link_list values are written as [[id]].
 */
export async function handleSet(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "add", "remove"], ["add", "remove"], ["clear"]);
  const [id, rawField, ...values] = parsed.positionals;
  // SLICE-0088: normalize the field name at the parse boundary so a name copied
  // from `wiki schema` works whether typed kebab (parent-prd) or snake (parent_prd).
  const field = rawField === undefined ? undefined : rawField.replace(/-/g, "_");
  const add = listValue(parsed.values.add);
  const remove = listValue(parsed.values.remove);
  const clear = booleanValue(parsed.values, "clear");
  const additive = add.length > 0 || remove.length > 0 || clear;

  if (id === undefined || field === undefined || (!additive && values.length === 0)) {
    return fail("usage: wiki set <id> <field> <value...> | --add <v> | --remove <v> | --clear [--project <name>]");
  }
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);

  if (additive) return setListField(target, field, { add, remove, clear });

  const coerced = await coerceValue(target.type, field, values);
  if (!coerced.ok) return fail(coerced.error);

  return run(target, () => setField({ ...target, field, value: coerced.value }, target.structure), (artifact) => ({
    id: target.id,
    field,
    value: artifact.fields[field] ?? null,
  }), `set ${field} on ${target.id}`);
}

/** Additive list mutation: read current value, apply add/remove/clear, validate-write. */
async function setListField(
  target: Target,
  field: string,
  ops: { add: string[]; remove: string[]; clear: boolean },
): Promise<CliResult> {
  const schema = await loadTemplate(target.type);
  const def = schema.fields.find((candidate) => candidate.name === field);
  if (def === undefined) return fail(`unknown field for ${target.type}: ${field}`);
  if (def.type !== "list" && def.type !== "link_list") {
    return fail(`--add/--remove/--clear only apply to list or link_list fields; ${field} is ${def.type}`);
  }
  const isLinkList = def.type === "link_list";
  const wrap = (value: string) => (isLinkList && !/^\[\[.*\]\]$/.test(value) ? `[[${value}]]` : value);
  const bare = (value: string) => value.replace(/^\[\[/, "").replace(/\]\]$/, "");

  let current: string[];
  try {
    const existing = await readArtifact(target, target.structure);
    const value = existing.fields[field];
    current = Array.isArray(value) ? value.map(String) : [];
  } catch (error) {
    return handleError(error);
  }

  let next = ops.clear ? [] : [...current];
  for (const value of ops.add) {
    const wrapped = wrap(value);
    if (!next.some((item) => bare(item) === bare(wrapped))) next.push(wrapped);
  }
  if (ops.remove.length > 0) {
    const drop = new Set(ops.remove.map(bare));
    next = next.filter((item) => !drop.has(bare(item)));
  }

  return run(target, () => setField({ ...target, field, value: next }, target.structure), () => ({
    id: target.id,
    field,
    value: next,
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
  return run(target, () => setField({ ...target, field: "blocked_by", value: wrapped }, target.structure), () => ({
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
    await readArtifact({ type: target.type, vaultRoot: target.vaultRoot, project: target.project, id: by }, target.structure);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return fail(`superseding artifact not found: ${by}`);
    throw error;
  }
  return run(target, () => supersedeArtifact({ ...target, by }, target.structure), (artifact) => ({
    id: target.id,
    status: artifact.fields.status ?? null,
    superseded_by: by,
  }), `${target.id} superseded by ${by}`);
}

/** wiki path <id> — print the absolute file path (resolve-by-id without globbing, P1.4). */
export async function handlePath(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const id = parsed.positionals[0];
  if (id === undefined) return fail("usage: wiki path <id> [--project <name>]");
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);
  try {
    const artifact = await readArtifact(target, target.structure);
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
  return run(target, () => relocateArtifact({ ...target, title }, target.structure), (artifact) => ({
    id: target.id,
    title: artifact.fields.title ?? null,
    path: (artifact as { path?: string }).path ?? null,
  }), `retitled ${target.id}`);
}

/** wiki delete <id> [--force] — reference-aware removal; refuses if inbound links exist unless forced. */
export async function handleDelete(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["force"]);
  const id = parsed.positionals[0];
  if (id === undefined) return fail("usage: wiki delete <id> [--force] [--project <name>]");
  const target = await resolveTarget(id, parsed);
  if (typeof target === "string") return fail(target);

  let artifactPath: string;
  try {
    artifactPath = (await readArtifact(target, target.structure)).path;
  } catch (error) {
    return handleError(error);
  }

  // Scan inbound references via the id index; refuse unless --force.
  const index = await buildIdIndex(target.vaultRoot, target.project, target.structure);
  const inbound = await inboundReferences(index, target.id);
  if (inbound.length > 0 && !booleanValue(parsed.values, "force")) {
    return fail(
      `refusing to delete ${target.id}: ${inbound.length} inbound reference(s) (${inbound.join(", ")}). Re-run with --force to delete anyway.`,
      { inbound },
    );
  }

  // On --force, scrub the deleted id out of every inbound artifact's frontmatter
  // link fields first, so a forced delete does not manufacture the dangling-link
  // drift doctor exists to catch. Body prose `[[id]]` mentions are author content
  // (not auto-rewritten) — reported so the user knows what doctor will still flag.
  let scrub: ScrubResult | undefined;
  if (inbound.length > 0) {
    const inboundPaths = inbound.flatMap((refId) => index.get(refId) ?? []);
    scrub = await scrubInboundLinks(inboundPaths, target.id);
  }

  // sync owns search-index cleanup — delete only removes the file; re-run wiki sync to drop it from search.
  await rm(artifactPath, { force: true });
  if (jsonEnabled()) {
    emitJson({
      id: target.id,
      deleted: artifactPath,
      inbound,
      scrubbed: scrub?.scrubbedFiles ?? [],
      bodyMentions: scrub?.bodyMentions ?? [],
    });
  } else {
    console.log(`deleted ${target.id}${inbound.length > 0 ? ` (forced past ${inbound.length} inbound reference(s))` : ""}`);
    if (scrub !== undefined && scrub.scrubbedFiles.length > 0) {
      console.log(`scrubbed ${target.id} from ${scrub.scrubbedFiles.length} inbound frontmatter link field(s)`);
    }
    if (scrub !== undefined && scrub.bodyMentions.length > 0) {
      console.log(
        `note: ${scrub.bodyMentions.length} file(s) still mention ${target.id} in body text — edit the prose by hand: ${scrub.bodyMentions.map((p) => p.split("/").pop()).join(", ")}`,
      );
    }
  }
  return { code: 0 };
}

async function resolveTarget(id: string, parsed: ParsedCommand): Promise<Target | string> {
  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  const type = structure.typeForId(id);
  if (type === undefined) return `cannot infer artifact type from id: ${id}`;
  const project = await resolveProject(parsed);
  if (project === undefined) return "no project: pass --project <name> or run from a linked repo";
  return { type, vaultRoot, project, id, structure };
}

/** Coerce raw CLI string args to the field's schema type (booleans, integers, lists). */
type CoercedValue = { ok: true; value: unknown } | { ok: false; error: string };

async function coerceValue(type: TemplateType, field: string, values: string[]): Promise<CoercedValue> {
  const schema = await loadTemplate(type);
  const def = schema.fields.find((candidate) => candidate.name === field);
  if (def === undefined) return { ok: false, error: `unknown field for ${type}: ${field}` };
  if (def.type === "list" || def.type === "link_list") return { ok: true, value: values };
  if (values.length !== 1) return { ok: false, error: `field ${field} takes a single value` };
  const raw = values[0]!;
  if (def.type === "boolean") {
    if (raw === "true") return { ok: true, value: true };
    if (raw === "false") return { ok: true, value: false };
    return { ok: false, error: `field ${field} expects true|false` };
  }
  if (def.type === "integer") {
    const n = Number(raw);
    if (!Number.isInteger(n)) return { ok: false, error: `field ${field} expects an integer` };
    return { ok: true, value: n };
  }
  return { ok: true, value: raw };
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
    // SLICE-0088: append the computed expected set to the human message so an
    // enum rejection names the valid values, not just "invalid enum value".
    const message = error.errors
      .map((e) => `${e.field}: ${e.reason}${e.expected ? ` (expected: ${e.expected})` : ""}`)
      .join("; ");
    return fail(message, first === undefined ? {} : { field: first.field, expected: first.expected });
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
