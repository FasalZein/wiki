import matter from "gray-matter";
import { readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { obsidianCreate } from "../integrations/obsidian";

import { loadTemplate, resolveTemplatePath, type TemplateType } from "../schema/load";
import { validate } from "../schema/validate";
import type { NormalizedRecord, Schema, ValidationError } from "../schema/types";
import { nextId } from "./id";
import { artifactDirectory } from "./paths";
import { applyDefaults, renderArtifact } from "./render";

export type CreateArtifactInput = {
  type: TemplateType;
  vaultRoot: string;
  project: string;
  fields: Record<string, unknown>;
  /** Optional category subfolder for docs, e.g. docs/research/. */
  category?: string;
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
  /** New doc category subfolder, e.g. "architecture". Docs only. */
  category?: string;
};

export type AppendFieldInput = SetFieldInput;

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

export async function readArtifact(input: ReadArtifactInput): Promise<Artifact> {
  const path = await resolveArtifactPath(input.type, input.vaultRoot, input.project, input.id);
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

export async function setField(input: SetFieldInput): Promise<Artifact> {
  return setFields({
    type: input.type,
    vaultRoot: input.vaultRoot,
    project: input.project,
    id: input.id,
    fields: { [input.field]: input.value },
  });
}

export async function setFields(input: SetFieldsInput): Promise<Artifact> {
  const existing = await readArtifact(input);
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

export async function appendField(input: AppendFieldInput): Promise<Artifact> {
  const schema = await loadTemplate(input.type);
  const field = schema.fields.find((candidate) => candidate.name === input.field);
  if (field === undefined || (field.type !== "list" && field.type !== "link_list")) {
    throw new ArtifactValidationError([{ field: input.field, reason: "not a list field", expected: "list" }]);
  }
  const existing = await readArtifact(input);
  const current = existing.fields[input.field];
  const list = Array.isArray(current) ? current : [];
  return writeFields(input, existing, {
    ...existing.fields,
    [input.field]: [...list, input.value],
  });
}

export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  const schema = await loadTemplate(input.type);
  const templateFile = Bun.file(resolveTemplatePath(`${input.type}.md`));
  const template = await templateFile.text();
  const id = await nextId(input.type, input.vaultRoot, input.project);
  const suppliedAliases = Array.isArray(input.fields.aliases) ? input.fields.aliases.map(String) : [];
  const aliases = suppliedAliases.includes(id) ? suppliedAliases : [id, ...suppliedAliases];
  const fields = applyDefaults(schema, template, {
    ...input.fields,
    id,
    aliases,
    project: input.project,
  });
  const result = validate(schema, fields);
  if (!result.ok) {
    throw new ArtifactValidationError(result.errors);
  }

  const content = renderArtifact(template, result.value);
  const path = artifactPath(input.type, input.vaultRoot, input.project, id, String(result.value.title ?? id), input.category);
  await writeArtifact(input.vaultRoot, path, content);

  return {
    id,
    path,
    fields: result.value,
    body: content,
  };
}

/**
 * Move and/or retitle an existing artifact on disk. Updates the `title` field
 * (and re-slugs the filename) when `title` is given, and moves the file into a
 * new doc category subfolder when `category` is given. The id is preserved, so
 * [[ID]] links and id-based reads keep resolving. The old file is removed.
 */
export async function relocateArtifact(input: RelocateArtifactInput): Promise<Artifact> {
  const existing = await readArtifact(input);
  const nextTitle = input.title ?? (typeof existing.fields.title === "string" ? existing.fields.title : input.id);

  const fields: NormalizedRecord = { ...existing.fields };
  if (input.title !== undefined) {
    fields.title = input.title;
  }

  const directory = artifactDirectory(input.type, input.vaultRoot, input.project);
  const fileName = `${input.id}-${slugifyTitle(nextTitle)}.md`;
  // Preserve the doc's current category subfolder unless an explicit move is requested.
  const currentCategory = input.type === "doc" ? existingCategory(directory, existing.path) : undefined;
  const category = input.type === "doc" ? (input.category ?? currentCategory) : undefined;
  const destination = category !== undefined && category.length > 0
    ? join(directory, category, fileName)
    : join(directory, fileName);

  const content = matter.stringify(existing.body, { ...fields, updated: new Date().toISOString().slice(0, 10) });
  await writeArtifact(input.vaultRoot, destination, content);
  if (destination !== existing.path) {
    await rm(existing.path, { force: true });
  }
  const parsed = matter(content);
  return { id: input.id, path: destination, fields: parsed.data, body: parsed.content.trimStart() };
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
  await writeArtifact(input.vaultRoot, existing.path, content);
  return { ...existing, fields: result.value };
}

async function writeArtifact(vaultRoot: string, path: string, content: string): Promise<void> {
  const rel = relative(vaultRoot, path);
  const name = basename(rel, ".md");
  const folder = dirname(rel);
  await obsidianCreate(name, content, folder, { silent: true, overwrite: true });
}

function artifactPath(type: TemplateType, vaultRoot: string, project: string, id: string, title: string, category?: string): string {
  const directory = artifactDirectory(type, vaultRoot, project);
  const fileName = `${id}-${slugifyTitle(title)}.md`;
  if (type === "doc" && category !== undefined && category.length > 0) {
    return join(directory, category, fileName);
  }
  return join(directory, fileName);
}

async function resolveArtifactPath(type: TemplateType, vaultRoot: string, project: string, id: string): Promise<string> {
  const directory = artifactDirectory(type, vaultRoot, project);
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

function existingCategory(docsDirectory: string, currentPath: string): string | undefined {
  const rel = relative(docsDirectory, currentPath);
  const segments = rel.split(/[/\\]/);
  // docs/<category>/<file>.md -> category is the first segment when nested.
  return segments.length > 1 ? segments[0] : undefined;
}

function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug.slice(0, 80).replace(/-+$/g, "") : "untitled";
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
