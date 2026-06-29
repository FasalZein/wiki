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
  setField,
  supersedeArtifact,
} from "../../artifacts/store";
import { authoredSections } from "../../artifacts/body";
import { projectPath } from "../../artifacts/paths";
import { DEFAULT_STRUCTURE, loadStructure, parentBacklink, type Structure } from "../../artifacts/registry";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, normalizeInlineMaps, resolveTemplatePath, type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";
import { resolveProject } from "../resolve-project";
import { unknownMessage } from "../usage";

export async function handleCreate(args: string[]): Promise<CliResult> {
  const [name, ...rest] = args;
  // SLICE-0112: the create-name is a section kind (e.g. `doc`) OR a bucket/leaf
  // name in the tree (e.g. `architecture`, which files into the doc section's
  // docs/architecture/ with a DOC id). Resolve it synchronously against the
  // bundled default tree so an unknown name fails before any vault load (the
  // `create bogus` contract runs with no vault configured).
  if (name !== undefined && DEFAULT_STRUCTURE.kinds[name] !== undefined) {
    return createGeneric(name as TemplateType, rest);
  }
  const resolved = name === undefined ? undefined : DEFAULT_STRUCTURE.bucketFor(name);
  if (resolved !== undefined) {
    // A branch bucket carries an explicit subfolder; a leaf bucket (name === its
    // section) files straight into the section folder, so no preset category.
    const presetCategory = resolved.section.tree === "branch" ? resolved.bucket.name : undefined;
    return createGeneric(resolved.section.name, rest, presetCategory);
  }
  console.error(unknownMessage("artifact type", name ?? "", Object.keys(DEFAULT_STRUCTURE.kinds)));
  return { code: 1 };
}

/** Snake-case schema/placeholder name -> kebab CLI flag (e.g. parent_prd -> parent-prd). */
function flagName(field: string): string {
  return field.replace(/_/g, "-");
}

/** Normalize an argv token: a --flag[=value]'s name has its _ folded to - (value untouched). */
function normalizeFlagToken(token: string): string {
  if (!token.startsWith("--")) return token;
  const eq = token.indexOf("=");
  const name = eq === -1 ? token : token.slice(0, eq);
  const rest = eq === -1 ? "" : token.slice(eq);
  return name.replace(/_/g, "-") + rest;
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
async function createGeneric(kind: TemplateType, args: string[], presetCategory?: string): Promise<CliResult> {
  const schema = await loadTemplate(kind);
  const template = await Bun.file(resolveTemplatePath(`${kind}.md`)).text();
  const schemaNames = new Set(schema.fields.map((field) => field.name));
  const placeholders = authoredSections(matter(normalizeInlineMaps(template)).content, schemaNames).map((s) => s.placeholder);

  // One derived classification drives BOTH the parser config and value
  // extraction below — schema fields (minus the CLI/override-owned set) tagged
  // by how they parse, then placeholders, which always parse as plain strings.
  type FlagSpec = { flag: string; source: string; kind: "list" | "boolean" | "string" };
  const flagSpecs: FlagSpec[] = [];
  for (const field of schema.fields) {
    if (NON_FLAG_FIELDS.has(field.name)) continue;
    const isList = field.type === "list" || field.type === "link_list";
    flagSpecs.push({
      flag: flagName(field.name),
      source: field.name,
      kind: isList ? "list" : field.type === "boolean" ? "boolean" : "string",
    });
  }
  for (const placeholder of placeholders) {
    flagSpecs.push({ flag: flagName(placeholder), source: placeholder, kind: "string" });
  }

  const stringFlags = ["project", "body", "category", "force-new", "related-to", "supersedes"];
  const multipleFlags: string[] = [];
  const booleanFlags: string[] = [];
  for (const spec of flagSpecs) {
    if (spec.kind === "boolean") {
      booleanFlags.push(spec.flag);
    } else {
      stringFlags.push(spec.flag);
      if (spec.kind === "list") multipleFlags.push(spec.flag);
    }
  }

  // SLICE-0088: normalize incoming flag tokens to kebab so a snake_case name
  // copied from `wiki schema` (e.g. --parent_prd) matches the kebab CLI flags.
  const parsed = parseCommand(args.map(normalizeFlagToken), stringFlags, multipleFlags, booleanFlags);

  const project = await resolveProject(parsed);
  const missing = missingFields({ project });
  if (missing) return missing;
  if (project === undefined) return { code: 1 };

  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);

  const fields: Record<string, unknown> = {};
  for (const spec of flagSpecs) {
    if (spec.kind === "list") {
      const value = parsed.values[spec.flag];
      if (Array.isArray(value) && value.length > 0) fields[spec.source] = value;
    } else if (spec.kind === "boolean") {
      if (parsed.values[spec.flag] === true) fields[spec.source] = true;
    } else {
      const value = stringValue(parsed.values, spec.flag);
      if (value !== undefined) fields[spec.source] = value;
    }
  }

  // The bucket subfolder. SLICE-0112: a bucket/leaf name passed as the create-name
  // resolves to a section + subfolder (presetCategory). Otherwise --category names
  // a bucket of this section, validated against the loaded tree. SLICE-0117: with the
  // doc `type` enum gone, a bare `wiki create doc` with no bucket defaults to `notes`
  // (the catch-all) so it files into a declared bucket, not loose in docs/.
  const section = structure.sections.find((s) => s.name === kind);
  const bucketNames = section?.buckets.map((b) => b.name) ?? [];
  const explicitCategory = stringValue(parsed.values, "category");
  if (explicitCategory !== undefined && !bucketNames.includes(explicitCategory)) {
    console.error(`unknown category: ${explicitCategory}`);
    console.error(`category must be one of: ${bucketNames.join(", ")}`);
    return { code: 1 };
  }
  const category = presetCategory
    ?? explicitCategory
    ?? (kind === "doc" ? "notes" : undefined);

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
    vaultRoot,
    structure,
  });
}

type CreateRequest = {
  type: TemplateType;
  project: string;
  dedupQuery: string;
  fields: Record<string, unknown>;
  rawValues: Record<string, string | string[] | boolean | undefined>;
  category?: string;
  body?: string;
  vaultRoot: string;
  structure: Structure;
};

async function createWithSupersede(req: CreateRequest): Promise<CliResult> {
  const { type, project, dedupQuery, fields, rawValues, category, body, vaultRoot, structure } = req;
  const override = parseOverride(rawValues);
  if (typeof override === "string") { console.error(override); return { code: 1 }; }

  const projPath = projectPath(vaultRoot, project);
  await assertProjectStructure(projPath, structure);
  try {
    // Snapshot the to-be-superseded artifact (single read) so a post-write
    // failure can byte-restore it. setFields can't undo the supersede: it merges
    // onto the *current* (already-mutated) frontmatter, so the added
    // `superseded_by` would survive a field-level revert.
    const supersededBefore = override.kind === "supersedes"
      ? await readArtifact({ type, vaultRoot, project, id: override.id }, structure)
      : null;
    const supersededSnapshot = supersededBefore ? await Bun.file(supersededBefore.path).text() : null;
    // Pre-flight the parent before any write, mirroring backlinkParent's guard,
    // so a missing/garbage parent id fails before supersede runs. The parent
    // relationship is config-declared (SLICE-0114), not a slice/prd special.
    const backlink = parentBacklink(structure, type);
    if (backlink !== undefined) {
      const parentId = fields[backlink.parentField];
      if (typeof parentId === "string" && parentId.length > 0) {
        await readArtifact({ type: backlink.parentType, vaultRoot, project, id: parentId }, structure);
      }
    }
    const dedupBlock = await advisoryDedup(type, project, projPath, dedupQuery, override, structure);
    if (dedupBlock !== null) return dedupBlock;
    const artifact = await createArtifact({
      type,
      vaultRoot,
      project,
      category,
      body,
      fields: { ...fields, ...fieldsForDedupOverride(override) },
      structure,
    });
    // Post-write steps mutate *other* artifacts and can fail (e.g. supersede a
    // type without a `superseded` status). If any throws, roll back the new
    // artifact AND restore the superseded one so a half-applied create never
    // leaves an orphan (P0.2/P0.3).
    try {
      if (override.kind === "supersedes") {
        await supersedeArtifact({ type, vaultRoot, project, id: override.id, by: artifact.id }, structure);
      }
      await backlinkParent(type, vaultRoot, project, artifact.id, fields, structure);
    } catch (postWriteError) {
      await removeArtifactFile(artifact.path);
      if (supersededBefore && supersededSnapshot !== null) {
        await Bun.write(supersededBefore.path, supersededSnapshot);
      }
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
async function advisoryDedup(type: TemplateType, project: string, projectPath: string, query: string, override: DedupOverride, structure: Structure): Promise<CliResult | null> {
  if (override.kind !== "none" || !structure.specFor(type).dedup) return null;
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

/**
 * SLICE-0114 generic backlink (was the SLICE-0054 PRD<->slice special): when a
 * child kind that declares `parent: <kind>` is created with a `parent_<kind>` id,
 * append the child's id to the parent's config-declared `child_list` field. That
 * field is in NON_FLAG_FIELDS, so create never populates it from the child side —
 * this is the only place the backlink is written. Dedup-safe (no double-add),
 * create-if-absent (setField writes the list whether or not the parent had one).
 * Runs in createWithSupersede's rollback try block, so a missing/invalid parent
 * rolls back the child rather than orphaning it.
 */
async function backlinkParent(
  type: TemplateType,
  vaultRoot: string,
  project: string,
  childId: string,
  fields: Record<string, unknown>,
  structure: Structure,
): Promise<void> {
  const backlink = parentBacklink(structure, type);
  if (backlink === undefined) return;
  const parentId = fields[backlink.parentField];
  if (typeof parentId !== "string" || parentId.length === 0) return;
  const parent = await readArtifact({ type: backlink.parentType, vaultRoot, project, id: parentId }, structure);
  const current = Array.isArray(parent.fields[backlink.childListField]) ? (parent.fields[backlink.childListField] as unknown[]).map(String) : [];
  if (current.includes(childId)) return;
  await setField({ type: backlink.parentType, vaultRoot, project, id: parentId, field: backlink.childListField, value: [...current, childId] }, structure);
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
