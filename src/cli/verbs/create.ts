import { join, relative } from "node:path";

import {
  DedupBlockedError,
  formatCrossKindNote,
  formatSameKindAdvisory,
  QmdError,
  runDedupGate,
  type DedupOverride,
} from "../../artifacts/dedup";
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  type CreateResult,
  executeCreate,
} from "../../artifacts/store";
import { planCreate, type CreatePlan, type CreatePlanError } from "../../artifacts/create-plan";
import { loadKind, type Kind } from "../../artifacts/body";
import { projectPath } from "../../artifacts/paths";
import { DEFAULT_STRUCTURE, loadStructure, type Structure } from "../../artifacts/registry";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { loadCompiledTemplate, type TemplateType } from "../../schema/load";
import type { ValidationError } from "../../schema/types";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";
import { resolveProject } from "../resolve-project";
import { unknownMessage } from "../usage";

export async function handleCreate(args: string[]): Promise<CliResult> {
  const [name, ...rest] = args;
  // SLICE-0112/SLICE-0118 + BUG-4 (NOTE-0007): the create-name is a section kind
  // (e.g. `prd`) OR a bucket/leaf name in the tree. Resolve against the PER-VAULT
  // structure FIRST, so a vault whose wiki.json promotes/renames kinds wins over
  // the bundled default. (Previously the bundled DEFAULT_STRUCTURE was consulted
  // first, so a promoted kind like `notes` shadow-matched the default `doc`
  // bucket and misrouted to the removed `doc` kind.) Fall back to the bundled
  // default only when no vault is configured, preserving the `create bogus`
  // no-vault contract.
  const structure = await tryLoadStructure();
  if (structure !== undefined && name !== undefined) {
    if (structure.kinds[name] !== undefined) return createGeneric(name as TemplateType, rest);
    const resolved = structure.bucketFor(name);
    if (resolved !== undefined) return createGeneric(resolved.section.name, rest, presetFor(resolved));
  }
  // No vault (or unknown name there): resolve against the bundled default tree so
  // an unknown name still fails cleanly with no vault configured.
  if (name !== undefined && DEFAULT_STRUCTURE.kinds[name] !== undefined) {
    return createGeneric(name as TemplateType, rest);
  }
  const defaultResolved = name === undefined ? undefined : DEFAULT_STRUCTURE.bucketFor(name);
  if (defaultResolved !== undefined) {
    return createGeneric(defaultResolved.section.name, rest, presetFor(defaultResolved));
  }
  const kinds = Object.keys(structure?.kinds ?? DEFAULT_STRUCTURE.kinds);
  console.error(unknownMessage("artifact type", name ?? "", kinds));
  return { code: 1 };
}

/** A branch bucket carries an explicit subfolder; a leaf bucket (name === its
 *  section) files straight into the section folder, so no preset category. */
function presetFor(resolved: { section: { tree: "leaf" | "branch" }; bucket: { name: string } }): string | undefined {
  return resolved.section.tree === "branch" ? resolved.bucket.name : undefined;
}

/** Load the per-vault structure, or undefined when no vault is configured (so the
 *  `create bogus` contract still fails with the bundled kinds). A malformed
 *  wiki.json still throws — a present-but-broken config is a real error. */
async function tryLoadStructure(): Promise<Structure | undefined> {
  let vaultRoot: string;
  try {
    vaultRoot = await getVaultRoot();
  } catch {
    return undefined;
  }
  return loadStructure(vaultRoot);
}

/** Snake-case schema/placeholder name -> kebab CLI flag (e.g. parent_prd -> parent-prd). */
export function flagName(field: string): string {
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
 * Find the first `--flag` token that isn't a known flag for this kind, returning
 * its bare name (no leading `--`), or undefined when every flag is known. Only
 * `--`-prefixed tokens are inspected, so a value like `-` (the `--body` stdin
 * sentinel) or a flag value is never mistaken for an unknown flag. A token that
 * carries `=value` is split on the first `=`.
 */
function findUnknownFlag(args: string[], known: ReadonlySet<string>): string | undefined {
  for (const token of args) {
    if (!token.startsWith("--") || token === "--") continue;
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    if (name.length > 0 && !known.has(name)) return name;
  }
  return undefined;
}

/**
 * Fields the CLI sets itself, the dedup override owns, or other verbs manage —
 * never create-time flags. Every other schema field becomes a flag.
 */
export const NON_FLAG_FIELDS: ReadonlySet<string> = new Set([
  "id", "aliases", "project", "created", "updated", "session_date",
  "supersedes", "superseded_by", "related", "slices", "blocked_by", "force_new_reason",
]);

/**
 * An authorable create flag derived from a kind's schema (BUG-0001 / ADR-0046):
 * every schema field that is neither CLI-managed ({@link NON_FLAG_FIELDS}) nor an
 * `auto` field. Shared by `create <kind> --help` (renderBucketCreateHelp) and the
 * `wiki draft` skeleton so both render from the same loaded Kind and can't drift.
 */
export type AuthorableFlag = {
  flag: string;
  field: string;
  required: boolean;
  values?: string[];
  repeatable: boolean;
  default?: unknown;
};

export async function authorableFlags(type: TemplateType, vaultRoot?: string): Promise<AuthorableFlag[]> {
  const kind = await loadKind(type, vaultRoot);
  const { templateDefaults } = await loadCompiledTemplate(type, vaultRoot);
  const out: AuthorableFlag[] = [];
  for (const field of kind.schema.fields) {
    if (NON_FLAG_FIELDS.has(field.name) || field.auto === true) continue;
    out.push({
      flag: flagName(field.name),
      field: field.name,
      required: field.required,
      ...(field.constraints.values !== undefined ? { values: field.constraints.values } : {}),
      repeatable: field.type === "list" || field.type === "link_list",
      ...(templateDefaults[field.name] !== undefined ? { default: templateDefaults[field.name] } : {}),
    });
  }
  return out;
}

/** Format a template default for display (a list as `[a, b]`, else its string). */
export function formatDefault(value: unknown): string {
  return Array.isArray(value) ? `[${value.map(String).join(", ")}]` : String(value);
}

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
  // Resolve the vault root up front (best-effort) so a vault-shipped template (F1)
  // resolves for the loadKind below. A create with no vault configured still reaches
  // the bundled templates (vaultRoot undefined) and errors at the definite resolve later.
  let vaultRoot: string | undefined;
  try {
    vaultRoot = await getVaultRoot();
  } catch {
    vaultRoot = undefined;
  }
  const kindDef = await loadKind(kind, vaultRoot);
  const schema = kindDef.schema;
  const placeholders = kindDef.authoredSections().map((s) => s.placeholder);

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
  const normalizedArgs = args.map(normalizeFlagToken);
  // BUG-D (ADR-0044): reject an unknown flag BY NAME per kind, before parsing —
  // so `--tags` on a decision (which has no tags field) errors `decision has no
  // field: tags`, never the downstream "value beginning with '-' is ambiguous"
  // that the `--body -` stdin sentinel used to trip. Derived from the kind schema.
  const knownFlags = new Set([...stringFlags, ...booleanFlags]);
  const unknownFlag = findUnknownFlag(normalizedArgs, knownFlags);
  if (unknownFlag !== undefined) {
    // BUG-0001 item 4: if the flag's snake form IS a schema field but CLI-managed,
    // say WHY it isn't a flag instead of the bare "no field" (which sent the agent
    // guessing that fields go in body frontmatter). Truly-absent fields keep the
    // "no field" line, now pointing at `wiki schema` to discover the real ones.
    const snake = unknownFlag.replace(/-/g, "_");
    const field = schema.fields.find((f) => f.name === snake);
    if (field?.auto === true) {
      console.error(`--${unknownFlag}: ${snake} is set automatically — omit it`);
    } else if (field !== undefined) {
      console.error(`--${unknownFlag}: ${snake} is CLI-managed — edit after create with 'wiki set'`);
    } else {
      console.error(`${kind} has no field: ${unknownFlag}`);
      console.error(`run 'wiki schema ${kind}'`);
    }
    return { code: 1 };
  }
  const parsed = parseCommand(normalizedArgs, stringFlags, multipleFlags, booleanFlags);

  const project = await resolveProject(parsed);
  const missing = missingFields({ project });
  if (missing) return missing;
  if (project === undefined) return { code: 1 };

  // Definite resolve: if no vault was configured above, this throws the canonical
  // unconfigured error (create requires a vault to write into).
  if (vaultRoot === undefined) vaultRoot = await getVaultRoot();
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
  // doc `type` enum gone, a bare create on a BRANCH section files into a default
  // bucket so it lands in a declared folder, not loose in the section dir.
  const section = structure.sections.find((s) => s.name === kind);
  const bucketNames = section?.buckets.map((b) => b.name) ?? [];
  const explicitCategory = stringValue(parsed.values, "category");
  if (explicitCategory !== undefined && !bucketNames.includes(explicitCategory)) {
    console.error(`unknown category: ${explicitCategory}`);
    console.error(`category must be one of: ${bucketNames.join(", ")}`);
    return { code: 1 };
  }
  // Section-shape-driven default (no kind name hardcoded): a branch section with no
  // preset/explicit bucket defaults to its `notes` bucket if declared, else its first
  // declared bucket — always a real bucket of THIS vault's tree. A leaf section files
  // directly into the section folder (no subfolder), so its default stays undefined.
  const defaultBucket = section?.tree === "branch"
    ? (bucketNames.includes("notes") ? "notes" : bucketNames[0])
    : undefined;
  const category = presetCategory ?? explicitCategory ?? defaultBucket;

  const body = await stdinOrValue(stringValue(parsed.values, "body"));

  // Plan the create: cheap validation (BUG-C/NOTE-0010) + override + target
  // resolution, all pure. The plan cannot exist unvalidated, so the dedup gate
  // below physically cannot run against a bad field.
  const planned = planCreate(kind, kindDef, structure, {
    project,
    fields,
    body,
    category,
    forceNew: stringValue(parsed.values, "force-new"),
    relatedTo: stringValue(parsed.values, "related-to"),
    supersedes: stringValue(parsed.values, "supersedes"),
  });
  if (!planned.ok) return handlePlanError(planned.error, kindDef);
  const plan = planned.plan;

  const projPath = projectPath(vaultRoot, project);
  await assertProjectStructure(projPath, structure);

  // Dedup gate (advisory / interactive I/O stays in the verb) runs on the plan,
  // between plan and execute — it can abort the create or wave it through.
  const dedupBlock = await advisoryDedup(plan.type, project, projPath, plan.dedupQuery, plan.override, structure);
  if (dedupBlock !== null) return dedupBlock;

  try {
    const result = await executeCreate(plan, { vaultRoot, structure });
    return formatCreateOutput(result, plan, vaultRoot);
  } catch (error) {
    return handleCreateError(error, kindDef);
  }
}

/** Emit the create result — id to stdout (or the JSON record), the `created … at`
 *  note to stderr. SLICE-0064: no "run wiki sync" nag; indexing is `wiki sync`'s job. */
function formatCreateOutput(result: CreateResult, plan: CreatePlan, vaultRoot: string): CliResult {
  const { artifact } = result;
  if (jsonEnabled()) {
    emitJson({
      id: artifact.id,
      type: plan.type,
      project: plan.project,
      path: relative(vaultRoot, artifact.path),
      status: artifact.fields.status ?? null,
      supersedes: result.supersededId,
    });
  } else {
    console.log(artifact.id);
    console.error(`created ${artifact.id} at ${relative(vaultRoot, artifact.path)}`);
  }
  return { code: 0 };
}

/** Format a planCreate rejection to the same stderr/exit the old inline checks did:
 *  a validation error rides the shared handleCreateError (JSON field/expected shape);
 *  a bad override / unresolvable --related-to prints its one-liner at exit 1. */
function handlePlanError(error: CreatePlanError, kind: Kind): CliResult {
  if (error.kind === "validation") return handleCreateError(new ArtifactValidationError(error.errors), kind);
  console.error(error.message);
  return { code: 1 };
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
    await runDedupGate({ type, project, projectPath, config, query, override, structure });
    return null;
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      // ADR-0044: only SAME-kind matches can gate a create; cross-kind overlaps
      // print at most one non-blocking info line and never block. Advisory lines
      // always go to stderr (even in --json mode) so they never corrupt stdout.
      const sameKind = error.matches.filter((m) => m.sameKind);
      const crossKind = error.matches.filter((m) => !m.sameKind);
      const topCross = crossKind.sort((a, b) => b.score - a.score)[0];
      if (topCross !== undefined) console.error(formatCrossKindNote(topCross));
      for (const match of sameKind) console.error(formatSameKindAdvisory(match));

      const strong = sameKind.some((match) => match.strength === "strong");
      if (strong && config.dedup_strong_blocks) {
        if (jsonEnabled()) {
          emitJsonError({
            error: "strong duplicate match — refusing to create",
            matches: sameKind.map((m) => ({ id: m.id, kind: m.kind, score: m.score, strength: m.strength })),
          });
        } else {
          console.error("strong duplicate match — refusing to create. Pass --supersedes <id>, --related-to <id>, or --force-new \"reason\" to proceed.");
        }
        return { code: 1 };
      }
      return null;
    }
    if (error instanceof QmdError) {
      console.error(`dedup check skipped: ${error.summary}`);
      return null;
    }
    throw error;
  }
}

function handleCreateError(error: unknown, kind?: Kind): CliResult {
  if (error instanceof ArtifactValidationError || error instanceof ArtifactNotFoundError) {
    if (jsonEnabled()) {
      const first = error instanceof ArtifactValidationError ? error.errors[0] : undefined;
      emitJsonError({ error: error.message, ...(first === undefined ? {} : { field: first.field, expected: first.expected }) });
    } else if (error instanceof ArtifactValidationError && kind !== undefined) {
      // BUG-0001 item 3: in the create context, speak CLI language — a required/enum
      // error names the flag AND its values, so the agent's next call is the fix.
      console.error(error.errors.map((e) => formatCreateFieldError(e, kind)).join("\n"));
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

/**
 * Render one create-time validation error in CLI (flag) language (BUG-0001 item 3):
 * `phase: required — pass --phase <plan|prd|slice|handoff|ad-hoc>`. Required and enum
 * errors get the `pass --flag <hint>` suffix (the hint is the enum values, else
 * `<value>`); length/pattern reasons already embed their own fix, so they pass through.
 */
function formatCreateFieldError(error: ValidationError, kind: Kind): string {
  const base = `${error.field}: ${error.reason}`;
  if (error.reason !== "required" && error.reason !== "invalid enum value") return base;
  const values = kind.schema.fields.find((f) => f.name === error.field)?.constraints.values;
  const hint = values !== undefined ? `<${values.join("|")}>` : "<value>";
  return `${base} — pass --${flagName(error.field)} ${hint}`;
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

/**
 * SLICE-0118: render `wiki create <bucket> --help` for a bucket/leaf that has no
 * curated USAGE_REGISTRY entry, surfacing its config-declared `criteria` (the
 * what-goes-where signal) read from the per-vault loaded Structure. Returns null
 * when the name resolves to no bucket, so dispatch falls back to generic help.
 */
export async function renderBucketCreateHelp(name: string): Promise<string | null> {
  let vaultRoot: string | undefined;
  try {
    vaultRoot = await getVaultRoot();
  } catch {
    vaultRoot = undefined;
  }
  const structure = (await tryLoadStructure()) ?? DEFAULT_STRUCTURE;
  const resolved = structure.bucketFor(name);
  if (resolved === undefined) return null;
  const { section, bucket } = resolved;
  const lines: string[] = [];
  lines.push(`Create a ${section.name} artifact in the '${bucket.name}' bucket (files into ${bucket.folder}/, id prefix ${section.prefix}).`);
  lines.push("");
  lines.push(`usage: wiki create ${bucket.name} --project <name> --title <title> [--body -]`);
  // BUG-0001 item 5: render the kind's flags (required first, enums inline) from the
  // loaded Kind so `create <kind> --help` no longer hides them. A vault kind may lack
  // a bundled template — fall back to the schema-pointer line when loadKind throws.
  try {
    const flags = await authorableFlags(bucket.template, vaultRoot);
    lines.push("");
    lines.push("Flags:");
    lines.push(...renderCreateFlagLines(flags));
  } catch {
    lines.push("");
    lines.push(`Run 'wiki schema ${bucket.name}' for this bucket's fields.`);
  }
  if (bucket.criteria !== undefined) {
    lines.push("");
    lines.push(`Criteria: ${bucket.criteria}`);
  }
  return lines.join("\n");
}

/** The `Flags:` body for `create <kind> --help`: required flags first (enum values
 *  inline), then optional (defaults noted, list fields marked repeatable), then the
 *  `--body -` line. Shared shape with `wiki draft` via {@link authorableFlags}. */
function renderCreateFlagLines(flags: AuthorableFlag[]): string[] {
  const ordered = [...flags.filter((f) => f.required), ...flags.filter((f) => !f.required)];
  const lines = ordered.map((f) => {
    const value = f.values !== undefined ? `<${f.values.join("|")}>` : "<value>";
    const tags = [f.required ? "required" : "optional"];
    if (f.repeatable) tags.push("repeatable");
    if (!f.required && f.default !== undefined) tags.push(`default: ${formatDefault(f.default)}`);
    return `  --${f.flag} ${value}`.padEnd(44) + tags.join(", ");
  });
  lines.push(`  --body -`.padEnd(44) + "authored markdown body via stdin");
  return lines;
}
