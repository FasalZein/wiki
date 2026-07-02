import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadTemplate, type TemplateType } from "../schema/load";
import { BodyParseError, loadKind } from "./body";
import { type ArtifactFile, openArtifact, serializeArtifact } from "./artifact-file";
import type { NormalizedRecord, Schema, ValidationError } from "../schema/types";
import { parentBacklink, type Structure } from "./registry";
import type { CreatePlan } from "./create-plan";
import { fieldsForDedupOverride } from "./dedup";
import { nextId } from "./id";
import { withProjectLock } from "./lock";
import { IdIndex } from "./id-index";
import { bareIdOf } from "./references";
import { artifactDirectory, assertSafeSegment, projectPath } from "./paths";
import { projectIndex, resolveQmdCommandLazy } from "../integrations/project-index";
import { loadProjectConfig } from "../config/project";
import { isFileNotFound } from "../util";
import { orderBySchema } from "./render";

export type CreateArtifactInput = {
  type: TemplateType;
  vaultRoot: string;
  project: string;
  fields: Record<string, unknown>;
  /** Bucket subfolder relative to the section folder, e.g. "research" for docs/research/.
   *  A bucket/leaf name resolves to its section + subfolder in the create verb (SLICE-0112). */
  category?: string;
  /** Authored body markdown; parsed by H2 headings into template sections (ADR-0031). */
  body?: string;
  /** Per-vault structure (folders/prefixes), resolved once per verb and threaded. */
  structure: Structure;
};

export type ReadArtifactInput = {
  type: TemplateType;
  vaultRoot: string;
  project: string;
  id: string;
};

export type SetFieldInput = ReadArtifactInput & {
  field: string;
  value: unknown;
};

export type SetFieldsInput = ReadArtifactInput & {
  fields: Record<string, unknown>;
};

export type RelocateArtifactInput = ReadArtifactInput & {
  /** New title; updates the `title` field and re-slugs the filename. */
  title?: string;
  /** Target bucket/leaf name (SLICE-0115). A same-section move keeps the id (inbound
   *  [[id]] links stay resolvable); a cross-section move RE-MINTS the id in the target
   *  section's id-space (the settled rule; no link rewriting). Omit for a pure retitle. */
  bucket?: string;
};

export type Artifact = {
  id: string;
  path: string;
  fields: NormalizedRecord;
  body: string;
};

export class ArtifactValidationError extends Error {
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(errors.map(formatValidationError).join("; "));
    this.errors = errors;
  }
}

/** Render one validation error, appending its `expected` fix (BUG-0001 item 2) —
 *  `phase: required — expected one of: plan, prd, ...`. Length/range reasons already
 *  embed their numbers (`3 chars, min 5 — add 2`), so the expected suffix is skipped
 *  for them to avoid a double-print; the bare reasons (required, type mismatch,
 *  invalid enum value, pattern mismatch) get it. */
function formatValidationError(error: ValidationError): string {
  const base = `${error.field}: ${error.reason}`;
  if (error.expected === undefined || /,\s(?:min|max)\s/.test(error.reason)) return base;
  return `${base} — expected ${error.expected}`;
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`artifact not found: ${id}`);
  }
}

/** Resolve an artifact's path and open it, mapping a missing file to the domain
 *  {@link ArtifactNotFoundError}. The one read seam readArtifact and the narrowed
 *  writers (supersede/relocate) share. */
async function resolveAndOpen(input: ReadArtifactInput, structure: Structure, index?: IdIndex): Promise<ArtifactFile> {
  const path = await resolveArtifactPath(input.type, input.vaultRoot, input.project, input.id, structure, index);
  try {
    return await openArtifact(path);
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new ArtifactNotFoundError(input.id);
    }
    throw error;
  }
}

export async function readArtifact(input: ReadArtifactInput, structure: Structure, index?: IdIndex): Promise<Artifact> {
  const file = await resolveAndOpen(input, structure, index);
  return {
    id: input.id,
    path: file.path,
    fields: file.data as NormalizedRecord,
    body: file.body.trimStart(),
  };
}

export async function setField(input: SetFieldInput, structure: Structure, index?: IdIndex): Promise<Artifact> {
  return setFields({
    type: input.type,
    vaultRoot: input.vaultRoot,
    project: input.project,
    id: input.id,
    fields: { [input.field]: input.value },
  }, structure, index);
}

export async function setFields(input: SetFieldsInput, structure: Structure, index?: IdIndex): Promise<Artifact> {
  const file = await resolveAndOpen(input, structure, index);
  const kind = await loadKind(input.type, input.vaultRoot);
  const placeholders = templatePlaceholders(kind.templateBody);
  const existingFields = file.data as NormalizedRecord;
  for (const field of Object.keys(input.fields)) {
    assertKnownField(kind.schema, existingFields, field, placeholders);
  }
  const result = await file.replaceValidated(kind.schema, { ...existingFields, ...input.fields });
  if (!result.ok) {
    throw new ArtifactValidationError(result.errors);
  }
  return { id: input.id, path: file.path, fields: result.value, body: file.body.trimStart() };
}

/**
 * Mark an existing artifact as superseded by another (P0.1, PRD-0020). Always
 * records `superseded_by`; only flips `status` to "superseded" when the type's
 * schema actually has that enum value (slices gained it in P0.1; docs have
 * neither and fall through unmarked). Shared by `create --supersedes` and the
 * `wiki supersede` verb so the conditional lives in exactly one place.
 *
 * PRD-0020: the TARGET write is NARROWED — it merges only the two tombstone
 * fields onto the target's EXISTING frontmatter, re-stamps `updated`, and writes
 * the target back WITHOUT re-validating the whole target against today's schema.
 * A target authored under an older schema (missing a now-required field) can
 * still be superseded; supersede marks a tombstone, it does not repair it, so
 * the missing/other fields and the body pass through verbatim. The NEW
 * (superseding) artifact stays fully validated by createArtifact — the
 * relaxation is target-only.
 */
export async function supersedeArtifact(input: ReadArtifactInput & { by: string }, structure: Structure, index?: IdIndex): Promise<Artifact> {
  const file = await resolveAndOpen(input, structure, index);
  const schema = await loadTemplate(input.type, input.vaultRoot);
  const statusField = schema.fields.find((field) => field.name === "status");
  const hasSupersededStatus = statusField?.constraints.values?.includes("superseded") ?? false;
  // Guard the ONE thing the narrowed write still owns: `superseded_by` must be a
  // real field on the target's schema. Types without it (e.g. docs) can't be
  // superseded — fail cleanly, named to the target, instead of writing a stray
  // frontmatter key. We deliberately do NOT run the full validate(schema, ...)
  // here: that is what rejected a schema-stale target with a misleading error.
  if (!schema.fields.some((field) => field.name === "superseded_by")) {
    throw new ArtifactValidationError([
      { field: "superseded_by", reason: `${input.type} ${input.id} cannot be superseded (no superseded_by field)` },
    ]);
  }
  const patch: Record<string, unknown> = { superseded_by: input.by };
  if (hasSupersededStatus) patch.status = "superseded";
  const fields = await file.rewriteFrontmatter(patch);
  return { id: input.id, path: file.path, fields, body: file.body.trimStart() };
}

/** Delete an artifact file by absolute path (rollback for a half-applied create). */
export async function removeArtifactFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Outcome of scrubbing one deleted id out of the vault's inbound links. */
export type ScrubResult = {
  /** Files whose frontmatter link fields were rewritten to drop the id. */
  scrubbedFiles: string[];
  /** Files that still mention the id in BODY prose (`[[id]]`) — author content,
   *  not auto-rewritten; reported so the caller can surface what doctor will flag. */
  bodyMentions: string[];
};

/**
 * Remove a deleted artifact's `id` from every other artifact's FRONTMATTER link
 * fields (string values equal to the id, and array items equal to it, matched via
 * {@link bareIdOf} so `[[id]]`, `id|alias`, `id#h` all count). Used by
 * `wiki delete --force` so a forced delete does not manufacture the dangling-link
 * drift doctor exists to catch. Body `[[id]]` prose mentions are NOT rewritten
 * (lossy author content) — they are reported in {@link ScrubResult.bodyMentions}.
 *
 * Each rewrite is a NARROWED write (the existing body verbatim + pruned
 * frontmatter): it does not re-validate the referrer against today's
 * schema, so a schema-stale referrer can still be scrubbed (same relaxation
 * {@link supersedeArtifact} uses — pruning a link is not the moment to enforce an
 * unrelated field). `paths` is the inbound set the caller already computed.
 */
export async function scrubInboundLinks(paths: string[], id: string): Promise<ScrubResult> {
  const scrubbedFiles: string[] = [];
  const bodyMentions: string[] = [];
  for (const path of paths) {
    let file: ArtifactFile;
    try {
      file = await openArtifact(path);
    } catch {
      continue;
    }
    const data = { ...file.data };
    let changed = false;
    for (const [name, value] of Object.entries(data)) {
      if (name === "id") continue;
      if (typeof value === "string" && bareIdOf(value) === id) {
        delete data[name];
        changed = true;
      } else if (Array.isArray(value)) {
        const kept = value.filter((item) => !(typeof item === "string" && bareIdOf(item) === id));
        if (kept.length !== value.length) {
          data[name] = kept;
          changed = true;
        }
      }
    }
    if (changed) {
      await writeArtifact(path, serializeArtifact(data, file.body));
      scrubbedFiles.push(path);
    }
    if (new RegExp(`\\[\\[${id}(?=[\\]|#])`).test(file.body)) bodyMentions.push(path);
  }
  return { scrubbedFiles, bodyMentions };
}

/** The outcome of a completed create transaction: the written artifact and the id
 *  it superseded (null when the create did not supersede). No console — the verb
 *  formats stdout/JSON from this. */
export type CreateResult = {
  artifact: Artifact;
  supersededId: string | null;
};

/**
 * The create transaction (ADR-0045 item 3): consume a validated {@link CreatePlan}
 * and own the ordered write → supersede → backlink sequence with rollback. Pure of
 * console/exit — throws the domain errors (ArtifactValidationError / ArtifactNotFound)
 * the verb maps to an exit code. The plan is already validated (see
 * {@link CreatePlan}), so this never re-does the field checks; it does the I/O.
 *
 * Rollback (P0.2/P0.3): the superseded target is snapshotted (byte-for-byte) before
 * the write, and every post-write mutation of OTHER artifacts (supersede, parent
 * backlink) runs under a try that, on any failure, removes the new file AND restores
 * the superseded target's exact bytes — so a half-applied create never leaves an
 * orphan or a target flipped to `superseded` pointing at a rolled-back id.
 */
export async function executeCreate(
  plan: CreatePlan,
  ctx: { vaultRoot: string; structure: Structure },
): Promise<CreateResult> {
  const { vaultRoot, structure } = ctx;
  const { type, project, override } = plan;

  // One id-index walk serves every resolution this transaction makes (supersede
  // target, parent/related preflight, parent backlink) instead of each re-walking.
  // Read cache only — the mint under the lock in createArtifact re-reads on its own.
  // Skip it for a plain create with nothing to resolve (only nextId walks then).
  const needsIndex = override.kind === "supersedes" || plan.parentRef !== undefined || plan.relatedRef !== undefined;
  const index = needsIndex ? await IdIndex.build(vaultRoot, project, structure) : undefined;

  // Snapshot the to-be-superseded artifact (single read) so a post-write failure
  // can byte-restore it. supersedeArtifact merges onto the CURRENT frontmatter, so
  // a field-level revert can't undo it — only the byte snapshot can.
  const supersededBefore = override.kind === "supersedes"
    ? await readArtifact({ type, vaultRoot, project, id: override.id }, structure, index)
    : null;
  const supersededSnapshot = supersededBefore ? await Bun.file(supersededBefore.path).text() : null;

  // Pre-flight the resolution targets before any write, mirroring backlinkParent's
  // guard: a missing/garbage parent or --related-to id fails before the write runs.
  if (plan.parentRef !== undefined) {
    await readArtifact({ type: plan.parentRef.type, vaultRoot, project, id: plan.parentRef.id }, structure, index);
  }
  if (plan.relatedRef !== undefined) {
    await readArtifact({ type: plan.relatedRef.type, vaultRoot, project, id: plan.relatedRef.id }, structure, index);
  }

  const artifact = await createArtifact({
    type,
    vaultRoot,
    project,
    category: plan.category,
    body: plan.body,
    fields: { ...plan.fields, ...fieldsForDedupOverride(override) },
    structure,
  });
  index?.note(artifact.id, artifact.path); // keep the read-cache honest past the write

  try {
    if (override.kind === "supersedes") {
      await supersedeArtifact({ type, vaultRoot, project, id: override.id, by: artifact.id }, structure, index);
    }
    await backlinkParent(plan, vaultRoot, artifact.id, structure, index);
  } catch (postWriteError) {
    await removeArtifactFile(artifact.path);
    if (supersededBefore && supersededSnapshot !== null) {
      await Bun.write(supersededBefore.path, supersededSnapshot);
    }
    throw postWriteError;
  }

  return { artifact, supersededId: override.kind === "supersedes" ? override.id : null };
}

/**
 * SLICE-0114 generic backlink: when a child kind that declares `parent: <kind>` is
 * created with a `parent_<kind>` id, append the child's id to the parent's
 * config-declared `child_list` field. That field is in the CLI's non-flag set, so
 * create never populates it from the child side — this is the only writer. Dedup-safe
 * (no double-add), create-if-absent. Runs in executeCreate's rollback try block, so a
 * missing/invalid parent rolls the child back rather than orphaning it.
 */
async function backlinkParent(plan: CreatePlan, vaultRoot: string, childId: string, structure: Structure, index?: IdIndex): Promise<void> {
  if (plan.parentRef === undefined) return;
  const backlink = parentBacklink(structure, plan.type);
  if (backlink === undefined) return;
  const parent = await readArtifact({ type: plan.parentRef.type, vaultRoot, project: plan.project, id: plan.parentRef.id }, structure, index);
  const current = Array.isArray(parent.fields[backlink.childListField]) ? (parent.fields[backlink.childListField] as unknown[]).map(String) : [];
  if (current.includes(childId)) return;
  await setField({ type: backlink.parentType, vaultRoot, project: plan.project, id: plan.parentRef.id, field: backlink.childListField, value: [...current, childId] }, structure, index);
}

export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  const structure = input.structure;
  const kind = await loadKind(input.type, input.vaultRoot);
  const schema = kind.schema;
  const suppliedAliases = Array.isArray(input.fields.aliases) ? input.fields.aliases.map(String) : [];

  // bodySections parsing is the same every attempt — compute once. A machine-owned
  // section whose authored content is derivable is absorbed into its backing field
  // (absorbedFields) and rendered canonically from that field, not from the body.
  let bodySections: Record<string, string> | undefined;
  let absorbedFields: Record<string, unknown> = {};
  if (input.body !== undefined) {
    try {
      const parsed = kind.parseBody(input.body);
      bodySections = parsed.sections;
      absorbedFields = parsed.absorbed;
    } catch (error) {
      if (error instanceof BodyParseError) {
        throw new ArtifactValidationError([{ field: "body", reason: error.message }]);
      }
      throw error;
    }
  }

  return mintAndWrite({ type: input.type, vaultRoot: input.vaultRoot, project: input.project, structure }, (id) => {
    const aliases = suppliedAliases.includes(id) ? suppliedAliases : [id, ...suppliedAliases];
    // Absorbed body fields fill in first; an explicit flag of the same name wins.
    const fields = kind.applyDefaults({ ...absorbedFields, ...input.fields, id, aliases, project: input.project });
    const result = kind.validate(fields);
    if (!result.ok) {
      throw new ArtifactValidationError(result.errors);
    }
    const content = kind.render(orderBySchema(schema, result.value), bodySections);
    const path = artifactPath(input.type, input.vaultRoot, input.project, id, String(result.value.title ?? id), structure, input.category);
    return { path, content, fields: result.value };
  });
}

/** What a {@link mintAndWrite} render callback returns for a minted id. */
type RenderedArtifact = { path: string; content: string; fields: NormalizedRecord };

/**
 * The canonical "allocate the next id and write the file exactly once" seam,
 * shared by {@link createArtifact} and the hook's in-child capture. The render
 * callback turns a freshly minted id into its target path + content.
 *
 * SLICE-0121: the nextId read-then-write is a duplicate-id race under parallel
 * writers — two creates with DIFFERENT titles each compute the same id, write
 * distinct paths, and both succeed (the `wx` flag only catches a same-PATH
 * clash). A per-project lockfile serializes the whole allocate->write section so
 * the second writer sees the first file and mints the next id. The exclusive
 * `wx` create + bounded retry stays as a cheap second guard for a same-path
 * collision. Different projects use different lockfiles, so they never contend.
 *
 * SLICE-0126: after the write, fire a cheap incremental qmd keyword `update` for
 * the project's collection so the new artifact is searchable with no manual `wiki
 * sync`. Vector `embed` stays owned by `wiki sync`; the write path never embeds.
 * Best-effort — a qmd fault (binary missing, not yet synced) must not fail the
 * write, since `wiki sync` is the durable reindex.
 *
 * Review follow-up (P1): the lock wraps ONLY allocate->write. qmd is a subprocess
 * that can take seconds (cold cache, large collection); a slow call held under the
 * lock could outlast the stale-reclaim window and let a waiter reclaim a LIVE lock
 * — reopening the duplicate-id race the lock exists to close. So the keyword update
 * runs AFTER the lock releases, and the capture path's advisory dedup gate runs
 * BEFORE this call (see capture.ts) — both unlocked. Neither needs the lock: dedup
 * is advisory and files-anyway, the keyword update is idempotent.
 */
export async function mintAndWrite(
  target: { type: TemplateType; vaultRoot: string; project: string; structure: Structure },
  render: (id: string) => RenderedArtifact,
): Promise<Artifact> {
  const artifact = await withProjectLock(target.vaultRoot, target.project, async () => {
    const MAX_ATTEMPTS = 8;
    for (let attempt = 0; ; attempt++) {
      const id = await nextId(target.type, target.vaultRoot, target.project, target.structure);
      const { path, content, fields } = render(id);
      try {
        await mkdir(dirname(path), { recursive: true }); // Bun.write auto-mkdirs; node writeFile does not
        await writeFile(path, content, { flag: "wx" }); // fails if path already exists
      } catch (error) {
        if (isFileExists(error) && attempt < MAX_ATTEMPTS) continue; // collision — recompute nextId
        throw error;
      }
      return { id, path, fields, body: content };
    }
  });
  await refreshKeywordIndex(target.vaultRoot, target.project); // unlocked — see above
  return artifact;
}

/**
 * SLICE-0126: fire a cheap incremental qmd keyword `update` for the project's
 * collection so a freshly written artifact is in the keyword index without a
 * manual `wiki sync`. Keyword-only: vector `embed` stays owned by `wiki sync`.
 * Best-effort by design — qmd resolution rides QMD_COMMAND -> _project.md
 * qmd_command -> `qmd`, and ANY fault (binary missing, project never synced) is
 * swallowed so the write still succeeds. `wiki sync` remains the durable reindex.
 */
async function refreshKeywordIndex(vaultRoot: string, project: string): Promise<void> {
  try {
    const projPath = projectPath(vaultRoot, project);
    // QMD_COMMAND skips the config load; without it, a config-less project throws
    // here and the outer catch skips this best-effort refresh (unchanged behavior).
    const command = await resolveQmdCommandLazy(() => loadProjectConfig(projPath));
    const index = projectIndex({ project, projectPath: projPath, config: { qmd_command: command } });
    await index.ensure(); // register on first write
    await index.refresh(); // keyword reindex only; no embed
  } catch {
    // qmd missing / project unconfigured / never synced — `wiki sync` is the
    // durable reindex, so a write must never fail on the freshness best-effort.
  }
}

/**
 * Move and/or retitle an existing artifact on disk — the section-agnostic
 * "move to bucket" (SLICE-0115, PRD-0019). Updates the `title` field (and
 * re-slugs the filename) when `title` is given, and files the artifact into the
 * target bucket's folder when `bucket` is given.
 *
 * A SAME-section move keeps the id (the section owns the id-space, so inbound
 * [[id]] links stay resolvable). A CROSS-section move RE-MINTS the id in the
 * target section's id-space — the settled rule; cross-section moves are rare and
 * this PRD does no link rewriting, so inbound [[OLD-ID]] links are not patched.
 * A pure retitle (no `bucket`) keeps the file in its current folder. The old
 * file is removed once the destination is written.
 */
export async function relocateArtifact(input: RelocateArtifactInput, structure: Structure): Promise<Artifact> {
  assertSafeSegment(input.id, "artifact id");
  const file = await resolveAndOpen(input, structure);
  const nextTitle = input.title ?? (typeof file.data.title === "string" ? file.data.title : input.id);

  const resolved = input.bucket !== undefined ? structure.bucketFor(input.bucket) : undefined;
  if (input.bucket !== undefined && resolved === undefined) {
    throw new ArtifactValidationError([
      { field: "bucket", reason: `unknown bucket: ${input.bucket}` },
    ]);
  }

  // Cross-section move: re-mint the id in the target section's id-space, then drop
  // the old file. The id/aliases are rewritten on the moved artifact; everything
  // else passes through (a move repositions, it does not re-validate or repair).
  if (resolved !== undefined && resolved.section.name !== input.type) {
    const moved = await mintAndWrite(
      { type: resolved.section.name, vaultRoot: input.vaultRoot, project: input.project, structure },
      (id) => {
        const aliases = remintAliases(file.data.aliases, input.id, id);
        const fields: NormalizedRecord = {
          ...(file.data as NormalizedRecord),
          id,
          ...(aliases !== undefined ? { aliases } : {}),
          title: nextTitle,
          updated: new Date().toISOString().slice(0, 10),
        };
        // Rewrite the moved artifact's OWN `[[OLD-ID]]` self-references to the new
        // id so the re-minted file stays internally consistent (mirrors doctor's
        // reassignId). Inbound links from OTHER files are still not rewritten — the
        // settled cross-section rule; doctor flags those as the documented ceiling.
        const body = file.body.trimStart().replace(new RegExp(`\\[\\[${input.id}(?=[\\]|#])`, "g"), `[[${id}`);
        const path = join(projectPath(input.vaultRoot, input.project), resolved.bucket.folder, `${id}-${slugifyTitle(nextTitle)}.md`);
        return { path, content: serializeArtifact(fields, body), fields };
      },
    );
    await rm(file.path, { force: true });
    return moved;
  }

  // Same-section move or pure retitle: id preserved so [[id]] links keep resolving.
  const fileName = `${input.id}-${slugifyTitle(nextTitle)}.md`;
  const destinationDir = resolved !== undefined
    ? join(projectPath(input.vaultRoot, input.project), resolved.bucket.folder)
    : dirname(file.path);
  const destination = join(destinationDir, fileName);

  if (destination !== file.path && (await Bun.file(destination).exists())) {
    throw new ArtifactValidationError([
      { field: "id", reason: `destination already exists: ${destination}` },
    ]);
  }

  // Narrowed write to the destination: merge the (optional) new title, re-stamp
  // updated, keep the body verbatim — a move repositions, it does not re-validate.
  const fields = await file.rewriteFrontmatter(input.title !== undefined ? { title: input.title } : {}, destination);
  if (destination !== file.path) {
    await rm(file.path, { force: true });
  }
  // Review follow-up (P2): a same-section move/retitle writes outside mintAndWrite,
  // so refresh the keyword index here too — otherwise the relocated artifact's new
  // path/title stays stale in the keyword index until the next `wiki sync`.
  await refreshKeywordIndex(input.vaultRoot, input.project);
  return { id: input.id, path: destination, fields, body: file.body.trimStart() };
}

/** Re-mint an artifact's `aliases` on a cross-section move: swap the old id for the
 *  new one, ensuring the new id is present. Returns undefined when there were none. */
function remintAliases(aliases: unknown, oldId: string, newId: string): string[] | undefined {
  if (!Array.isArray(aliases)) return undefined;
  const swapped = aliases.map((alias) => (alias === oldId ? newId : String(alias)));
  return swapped.includes(newId) ? swapped : [newId, ...swapped];
}

function assertKnownField(schema: Schema, existingFields: Record<string, unknown>, fieldName: string, placeholders: Set<string>): void {
  if (
    !schema.fields.some((field) => field.name === fieldName) &&
    existingFields[fieldName] === undefined &&
    !placeholders.has(fieldName)
  ) {
    throw new ArtifactValidationError([{ field: fieldName, reason: "unknown field" }]);
  }
}

function templatePlaceholders(template: string): Set<string> {
  return new Set([...template.matchAll(/{{([A-Za-z0-9_]+)}}/g)].map((match) => match[1]).filter(isString));
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

async function writeArtifact(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

function artifactPath(type: TemplateType, vaultRoot: string, project: string, id: string, title: string, structure: Structure, category?: string): string {
  const directory = artifactDirectory(type, vaultRoot, project, structure);
  const fileName = `${id}-${slugifyTitle(title)}.md`;
  if (category !== undefined && category.length > 0) {
    assertSafeSegment(category, "category"); // defense-in-depth: createArtifact is a public API
    return join(directory, category, fileName);
  }
  return join(directory, fileName);
}

async function resolveArtifactPath(type: TemplateType, vaultRoot: string, project: string, id: string, structure: Structure, index?: IdIndex): Promise<string> {
  assertSafeSegment(id, "artifact id");
  const directory = artifactDirectory(type, vaultRoot, project, structure);
  // A branch section files artifacts into bucket subfolders (recursive lookup); a
  // leaf holds files directly. Key on the section shape (config-driven), not the
  // literal "doc" kind, so this is correct for any vault. Resolution precedence
  // (id-index -> exact ID.md -> filename glob) lives in IdIndex.resolve (SLICE-0077).
  const isBranch = structure.sections.find((s) => s.name === type)?.tree === "branch";
  const idx = index ?? await IdIndex.build(vaultRoot, project, structure);
  return idx.resolve(id, directory, isBranch);
}

export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug.slice(0, 80).replace(/-+$/g, "") : "untitled";
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
