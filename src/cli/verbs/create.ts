import matter from "gray-matter";
import { join, relative } from "node:path";

import {
  DedupBlockedError,
  fieldsForDedupOverride,
  formatDedupBlocked,
  parseDedupOverride,
  QmdError,
  runDedupGate,
  type DedupOverride,
} from "../../artifacts/dedup";
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  createArtifact,
  readArtifact,
  removeArtifactFile,
  supersedeArtifact,
} from "../../artifacts/store";
import { authoredSections } from "../../artifacts/body";
import { ARTIFACTS, defaultCategoryForDocType, DOC_CATEGORIES, isDocCategory, specFor, type DocCategory } from "../../artifacts/registry";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, normalizeInlineMaps, resolveTemplatePath, type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";
import { resolveProject } from "../resolve-project";
import { unknownMessage } from "../usage";

export async function handleCreate(args: string[]): Promise<CliResult> {
  const [kind, ...rest] = args;
  if (kind === undefined || ARTIFACTS[kind] === undefined) {
    console.error(unknownMessage("artifact type", kind ?? "", Object.keys(ARTIFACTS)));
    return { code: 1 };
  }
  return createGeneric(kind, rest);
}

/** Snake-case schema/placeholder name -> kebab CLI flag (e.g. parent_prd -> parent-prd). */
function flagName(field: string): string {
  return field.replace(/_/g, "-");
}

/**
 * Fields the CLI sets itself, the dedup override owns, or other verbs manage —
 * never create-time flags. Every other schema field becomes a flag.
 */
const NON_FLAG_FIELDS: ReadonlySet<string> = new Set([
  "id", "aliases", "project", "created", "updated", "session_date",
  "supersedes", "superseded_by", "related", "slices", "blocked_by", "force_new_reason",
]);

/**
 * Schema-driven create for any kind in wiki.json (ADR-0035). Flags are derived
 * from templates/<kind>.md — every schema field (minus the CLI/override-owned set
 * above) plus every authored body placeholder — so a new kind needs only a config
 * entry and a template, no code. There is no per-kind branch and no fallback: an
 * unknown kind never reaches here (handleCreate hard-errors first). Provided values
 * pass through as `fields`; schema fields are validated, placeholders fall through
 * untouched and fill their `{{...}}` section.
 */
async function createGeneric(kind: TemplateType, args: string[]): Promise<CliResult> {
  const schema = await loadTemplate(kind);
  const template = await Bun.file(resolveTemplatePath(`${kind}.md`)).text();
  const schemaNames = new Set(schema.fields.map((field) => field.name));
  const placeholders = authoredSections(matter(normalizeInlineMaps(template)).content, schemaNames).map((s) => s.placeholder);

  const stringFlags = ["project", "body", "category", "force-new", "related-to", "supersedes"];
  const multipleFlags: string[] = [];
  const booleanFlags: string[] = [];
  for (const field of schema.fields) {
    if (NON_FLAG_FIELDS.has(field.name)) continue;
    const flag = flagName(field.name);
    if (field.type === "list" || field.type === "link_list") {
      stringFlags.push(flag);
      multipleFlags.push(flag);
    } else if (field.type === "boolean") {
      booleanFlags.push(flag);
    } else {
      stringFlags.push(flag);
    }
  }
  for (const placeholder of placeholders) stringFlags.push(flagName(placeholder));

  const parsed = parseCommand(args, stringFlags, multipleFlags, booleanFlags);

  const project = await resolveProject(parsed);
  const missing = missingFields({ project });
  if (missing) return missing;
  if (project === undefined) return { code: 1 };

  const fields: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (NON_FLAG_FIELDS.has(field.name)) continue;
    const flag = flagName(field.name);
    if (field.type === "list" || field.type === "link_list") {
      const value = parsed.values[flag];
      if (Array.isArray(value) && value.length > 0) fields[field.name] = value;
    } else if (field.type === "boolean") {
      if (parsed.values[flag] === true) fields[field.name] = true;
    } else {
      const value = stringValue(parsed.values, flag);
      if (value !== undefined) fields[field.name] = value;
    }
  }
  for (const placeholder of placeholders) {
    const value = stringValue(parsed.values, flagName(placeholder));
    if (value !== undefined) fields[placeholder] = value;
  }

  // Category is a doc subfolder, not a schema field: validate it, and for doc
  // default it from --type. Ignored by kinds that don't nest (only doc does).
  const explicitCategory = stringValue(parsed.values, "category");
  if (explicitCategory !== undefined && !isDocCategory(explicitCategory)) {
    console.error(`unknown category: ${explicitCategory}`);
    console.error(`category must be one of: ${DOC_CATEGORIES.join(", ")}`);
    return { code: 1 };
  }
  const category = explicitCategory ?? (kind === "doc" ? defaultCategoryForDocType(stringValue(parsed.values, "type")) : undefined);

  // Dedup query: title plus every authored body section the user supplied, in
  // template order — a uniform signal across kinds (no per-kind composition).
  const title = stringValue(parsed.values, "title");
  const dedupQuery = [title, ...placeholders.map((p) => fields[p])]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
  const body = await stdinOrValue(stringValue(parsed.values, "body"));
  return createWithSupersede({
    type: kind,
    project,
    dedupQuery,
    fields,
    rawValues: parsed.values,
    category,
    body,
  });
}

type CreateRequest = {
  type: TemplateType;
  project: string;
  dedupQuery: string;
  fields: Record<string, unknown>;
  rawValues: Record<string, string | string[] | boolean | undefined>;
  category?: DocCategory;
  body?: string;
};

async function createWithSupersede(req: CreateRequest): Promise<CliResult> {
  const { type, project, dedupQuery, fields, rawValues, category, body } = req;
  const override = parseOverride(rawValues);
  if (typeof override === "string") { console.error(override); return { code: 1 }; }

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  await assertProjectStructure(projectPath);
  try {
    if (override.kind === "supersedes") {
      await readArtifact({ type, vaultRoot, project, id: override.id });
    }
    const dedupBlock = await advisoryDedup(type, project, projectPath, dedupQuery, override);
    if (dedupBlock !== null) return dedupBlock;
    const artifact = await createArtifact({
      type,
      vaultRoot,
      project,
      category,
      body,
      fields: { ...fields, ...fieldsForDedupOverride(override) },
    });
    // Post-write steps mutate *other* artifacts and can fail (e.g. supersede a
    // type without a `superseded` status). If any throws, roll back the new
    // artifact so a half-applied create never leaves an orphan (P0.2/P0.3).
    try {
      if (override.kind === "supersedes") {
        await supersedeArtifact({ type, vaultRoot, project, id: override.id, by: artifact.id });
      }
    } catch (postWriteError) {
      await removeArtifactFile(artifact.path);
      throw postWriteError;
    }
    if (jsonEnabled()) {
      emitJson({
        id: artifact.id,
        type,
        project,
        path: relative(vaultRoot, artifact.path),
        status: artifact.fields.status ?? null,
        supersedes: override.kind === "supersedes" ? override.id : null,
      });
    } else {
      console.log(artifact.id);
      console.error(`created ${artifact.id} at ${relative(vaultRoot, artifact.path)}`);
      // SLICE-0064: no "run wiki sync" nag here. Coupling create to qmd makes
      // every write pay a slow, fragile index call — the opposite of the lean
      // delivery loop (PRD-0012). Indexing is owned by `wiki sync`; the wiki
      // skill guides syncing at the right altitude.
    }
    return { code: 0 };
  } catch (error) {
    return handleCreateError(error);
  }
}

/**
 * Run the dedup gate. Returns a CliResult to abort the create, or null to
 * proceed. Dedup is advisory by default (warn + link); a *strong* match blocks
 * only in opt-in strict mode (config.dedup_strong_blocks). *Weak* matches always
 * stay advisory and proceed.
 */
async function advisoryDedup(type: TemplateType, project: string, projectPath: string, query: string, override: DedupOverride): Promise<CliResult | null> {
  if (override.kind !== "none" || !specFor(type).dedup) return null;
  let config;
  try {
    config = await loadProjectConfig(projectPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(`dedup check skipped: ${error.message.split("\n")[0]}`);
      return null;
    }
    throw error;
  }
  try {
    await runDedupGate({ type, project, projectPath, config, query, override });
    return null;
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      const strong = error.matches.some((match) => match.strength === "strong");
      if (strong && config.dedup_strong_blocks) {
        if (jsonEnabled()) {
          emitJsonError({ error: "strong duplicate match — refusing to create", matches: error.matches.map((m) => ({ path: m.path, score: m.score, strength: m.strength })) });
        } else {
          console.error(formatDedupBlocked(error));
          console.error("strong duplicate match — refusing to create. Pass --supersedes <id>, --related-to <id>, or --force-new \"reason\" to proceed.");
        }
        return { code: 1 };
      }
      console.error(formatDedupBlocked(error));
      console.error("(advisory — proceeding with create)");
      return null;
    }
    if (error instanceof QmdError) {
      console.error(`dedup check skipped: ${error.summary}`);
      return null;
    }
    throw error;
  }
}

function parseOverride(values: Record<string, string | string[] | boolean | undefined>) {
  return parseDedupOverride({
    forceNew: stringValue(values, "force-new"),
    relatedTo: stringValue(values, "related-to"),
    supersedes: stringValue(values, "supersedes"),
  });
}

function handleCreateError(error: unknown): CliResult {
  if (error instanceof ArtifactValidationError || error instanceof ArtifactNotFoundError) {
    if (jsonEnabled()) {
      const first = error instanceof ArtifactValidationError ? error.errors[0] : undefined;
      emitJsonError({ error: error.message, ...(first === undefined ? {} : { field: first.field, expected: first.expected }) });
    } else {
      console.error(error.message);
    }
    return { code: 1 };
  }
  if (error instanceof ProjectConfigError) {
    if (jsonEnabled()) emitJsonError({ error: error.message });
    else console.error(error.message);
    return { code: 10 };
  }
  throw error;
}

function missingFields(fields: Record<string, unknown>): CliResult | null {
  const missing = Object.entries(fields).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }
  return null;
}

async function stdinOrValue(value: string | undefined): Promise<string | undefined> {
  if (value === "-") return Bun.stdin.text();
  return value;
}
