import matter from "gray-matter";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { loadTemplate, normalizeInlineMaps, resolveTemplatePath, type TemplateType } from "../schema/load";
import { BodyParseError, parseBodySections } from "./body";
import { validate } from "../schema/validate";
import type { NormalizedRecord, Schema, ValidationError } from "../schema/types";
import { type Structure } from "./registry";
import { nextId } from "./id";
import { buildIdIndex } from "./id-index";
import { artifactDirectory, assertSafeSegment, projectPath } from "./paths";
import { isFileNotFound } from "../util";
import { applyDefaults, orderBySchema, renderArtifact } from "./render";

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
    super(errors.map((error) => `${error.field}: ${error.reason}`).join("; "));
    this.errors = errors;
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`artifact not found: ${id}`);
  }
}

export async function readArtifact(input: ReadArtifactInput, structure: Structure): Promise<Artifact> {
  const path = await resolveArtifactPath(input.type, input.vaultRoot, input.project, input.id, structure);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new ArtifactNotFoundError(input.id);
    }
    throw error;
  }
  const parsed = matter(content);
  return {
    id: input.id,
    path,
    fields: parsed.data,
    body: parsed.content.trimStart(),
  };
}

export async function setField(input: SetFieldInput, structure: Structure): Promise<Artifact> {
  return setFields({
    type: input.type,
    vaultRoot: input.vaultRoot,
    project: input.project,
    id: input.id,
    fields: { [input.field]: input.value },
  }, structure);
}

export async function setFields(input: SetFieldsInput, structure: Structure): Promise<Artifact> {
  const existing = await readArtifact(input, structure);
  const schema = await loadTemplate(input.type);
  const template = await Bun.file(resolveTemplatePath(`${input.type}.md`)).text();
  const placeholders = templatePlaceholders(template);
  for (const field of Object.keys(input.fields)) {
    assertKnownField(schema, existing, field, placeholders);
  }
  return writeFields(input, existing, {
    ...existing.fields,
    ...input.fields,
  });
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
export async function supersedeArtifact(input: ReadArtifactInput & { by: string }, structure: Structure): Promise<Artifact> {
  const existing = await readArtifact(input, structure);
  const schema = await loadTemplate(input.type);
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
  const fields: NormalizedRecord = {
    ...existing.fields,
    superseded_by: input.by,
    updated: new Date().toISOString().slice(0, 10),
  };
  if (hasSupersededStatus) fields.status = "superseded";
  const content = matter.stringify(existing.body, fields);
  await writeArtifact(existing.path, content);
  return { ...existing, fields };
}

/** Delete an artifact file by absolute path (rollback for a half-applied create). */
export async function removeArtifactFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  const structure = input.structure;
  const schema = await loadTemplate(input.type);
  const templateFile = Bun.file(resolveTemplatePath(`${input.type}.md`));
  const template = await templateFile.text();
  const suppliedAliases = Array.isArray(input.fields.aliases) ? input.fields.aliases.map(String) : [];

  // bodySections parsing is the same every attempt — compute once.
  let bodySections: Record<string, string> | undefined;
  if (input.body !== undefined) {
    const fieldNames = new Set(schema.fields.map((field) => field.name));
    try {
      bodySections = parseBodySections(matter(normalizeInlineMaps(template)).content, fieldNames, input.body);
    } catch (error) {
      if (error instanceof BodyParseError) {
        throw new ArtifactValidationError([{ field: "body", reason: error.message }]);
      }
      throw error;
    }
  }

  return mintAndWrite({ type: input.type, vaultRoot: input.vaultRoot, project: input.project, structure }, (id) => {
    const aliases = suppliedAliases.includes(id) ? suppliedAliases : [id, ...suppliedAliases];
    const fields = applyDefaults(schema, template, { ...input.fields, id, aliases, project: input.project });
    const result = validate(schema, fields);
    if (!result.ok) {
      throw new ArtifactValidationError(result.errors);
    }
    const content = renderArtifact(template, orderBySchema(schema, result.value), bodySections);
    const path = artifactPath(input.type, input.vaultRoot, input.project, id, String(result.value.title ?? id), structure, input.category);
    return { path, content, fields: result.value };
  });
}

/** What a {@link mintAndWrite} render callback returns for a minted id. */
type RenderedArtifact = { path: string; content: string; fields: NormalizedRecord };

/**
 * The canonical "allocate the next id and write the file exactly once" seam,
 * shared by {@link createArtifact} and the hook's in-child capture. The render
 * callback turns a freshly minted id into its target path + content; this loop
 * owns the one thing both callers must get right: the nextId read-then-write is
 * a TOCTOU race under parallel writers, so an exclusive create (`wx`) plus a
 * bounded retry recomputes the id on collision rather than clobbering or
 * throwing. No lockfile.
 */
export async function mintAndWrite(
  target: { type: TemplateType; vaultRoot: string; project: string; structure: Structure },
  render: (id: string) => RenderedArtifact,
): Promise<Artifact> {
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
  const existing = await readArtifact(input, structure);
  const nextTitle = input.title ?? (typeof existing.fields.title === "string" ? existing.fields.title : input.id);

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
        const aliases = remintAliases(existing.fields.aliases, existing.id, id);
        const fields: NormalizedRecord = {
          ...existing.fields,
          id,
          ...(aliases !== undefined ? { aliases } : {}),
          title: nextTitle,
          updated: new Date().toISOString().slice(0, 10),
        };
        const path = join(projectPath(input.vaultRoot, input.project), resolved.bucket.folder, `${id}-${slugifyTitle(nextTitle)}.md`);
        return { path, content: matter.stringify(existing.body, fields), fields };
      },
    );
    await rm(existing.path, { force: true });
    return moved;
  }

  // Same-section move or pure retitle: id preserved so [[id]] links keep resolving.
  const fields: NormalizedRecord = { ...existing.fields };
  if (input.title !== undefined) {
    fields.title = input.title;
  }

  const fileName = `${input.id}-${slugifyTitle(nextTitle)}.md`;
  const destinationDir = resolved !== undefined
    ? join(projectPath(input.vaultRoot, input.project), resolved.bucket.folder)
    : dirname(existing.path);
  const destination = join(destinationDir, fileName);

  if (destination !== existing.path && (await Bun.file(destination).exists())) {
    throw new ArtifactValidationError([
      { field: "id", reason: `destination already exists: ${destination}` },
    ]);
  }

  const content = matter.stringify(existing.body, { ...fields, updated: new Date().toISOString().slice(0, 10) });
  await writeArtifact(destination, content);
  if (destination !== existing.path) {
    await rm(existing.path, { force: true });
  }
  const parsed = matter(content);
  return { id: input.id, path: destination, fields: parsed.data, body: parsed.content.trimStart() };
}

/** Re-mint an artifact's `aliases` on a cross-section move: swap the old id for the
 *  new one, ensuring the new id is present. Returns undefined when there were none. */
function remintAliases(aliases: unknown, oldId: string, newId: string): string[] | undefined {
  if (!Array.isArray(aliases)) return undefined;
  const swapped = aliases.map((alias) => (alias === oldId ? newId : String(alias)));
  return swapped.includes(newId) ? swapped : [newId, ...swapped];
}

function assertKnownField(schema: Schema, existing: Artifact, fieldName: string, placeholders: Set<string>): void {
  if (
    !schema.fields.some((field) => field.name === fieldName) &&
    existing.fields[fieldName] === undefined &&
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

async function writeFields(input: ReadArtifactInput, existing: Artifact, fields: NormalizedRecord): Promise<Artifact> {
  const schema = await loadTemplate(input.type);
  const result = validate(schema, {
    ...fields,
    updated: new Date().toISOString().slice(0, 10),
  });
  if (!result.ok) {
    throw new ArtifactValidationError(result.errors);
  }

  const content = matter.stringify(existing.body, result.value);
  await writeArtifact(existing.path, content);
  return { ...existing, fields: result.value };
}

async function writeArtifact(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

function artifactPath(type: TemplateType, vaultRoot: string, project: string, id: string, title: string, structure: Structure, category?: string): string {
  const directory = artifactDirectory(type, vaultRoot, project, structure);
  const fileName = `${id}-${slugifyTitle(title)}.md`;
  if (category !== undefined && category.length > 0) {
    return join(directory, category, fileName);
  }
  return join(directory, fileName);
}

async function resolveArtifactPath(type: TemplateType, vaultRoot: string, project: string, id: string, structure: Structure): Promise<string> {
  assertSafeSegment(id, "artifact id");
  const directory = artifactDirectory(type, vaultRoot, project, structure);

  // Frontmatter id is the spine: resolve through the id index first so date-named
  // and id-only files still reach repair verbs. Only accept a hit inside this
  // type's directory so a shared id can't pull in another kind's file.
  const indexed = (await buildIdIndex(vaultRoot, project, structure)).get(id);
  const inDir = indexed?.find((path) => path.startsWith(directory + sep) || dirname(path) === directory);
  if (inDir !== undefined) return inDir;

  const exact = join(directory, `${id}.md`);
  try {
    await readFile(exact, "utf8");
    return exact;
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }

  const match = type === "doc"
    ? await findArtifactFileRecursive(directory, id)
    : matchInNames(await readdir(directory).catch(() => [] as string[]), id, directory);
  return match ?? exact;
}

function matchInNames(entries: string[], id: string, directory: string): string | undefined {
  const match = entries.find((entry) => entry === `${id}.md` || (entry.startsWith(`${id}-`) && entry.endsWith(".md")));
  return match !== undefined ? join(directory, match) : undefined;
}

async function findArtifactFileRecursive(directory: string, id: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findArtifactFileRecursive(full, id);
      if (nested !== undefined) return nested;
    } else if (entry.isFile() && (entry.name === `${id}.md` || (entry.name.startsWith(`${id}-`) && entry.name.endsWith(".md")))) {
      return full;
    }
  }
  return undefined;
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
