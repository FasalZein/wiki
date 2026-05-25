import matter from "gray-matter";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadTemplate, type TemplateType } from "../schema/load";
import { validate } from "../schema/validate";
import type { NormalizedRecord, ValidationError } from "../schema/types";
import { nextId } from "./id";
import { artifactDirectory } from "./paths";
import { applyDefaults, renderArtifact } from "./render";

export type CreateArtifactInput = {
  type: TemplateType;
  vaultRoot: string;
  project: string;
  fields: Record<string, unknown>;
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
  const path = artifactPath(input.type, input.vaultRoot, input.project, input.id);
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
  for (const field of Object.keys(input.fields)) {
    await assertKnownField(input.type, existing, field);
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
  const templateFile = Bun.file(new URL(`../../templates/${input.type}.md`, import.meta.url));
  const template = await templateFile.text();
  const id = await nextId(input.type, input.vaultRoot, input.project);
  const fields = applyDefaults(schema, template, {
    ...input.fields,
    id,
    project: input.project,
  });
  const result = validate(schema, fields);
  if (!result.ok) {
    throw new ArtifactValidationError(result.errors);
  }

  const content = renderArtifact(template, result.value);
  const path = artifactPath(input.type, input.vaultRoot, input.project, id);
  await atomicWrite(path, content);

  return {
    id,
    path,
    fields: result.value,
    body: content,
  };
}

async function assertKnownField(type: TemplateType, existing: Artifact, fieldName: string): Promise<void> {
  const schema = await loadTemplate(type);
  const templateFile = Bun.file(new URL(`../../templates/${type}.md`, import.meta.url));
  const template = await templateFile.text();
  if (
    !schema.fields.some((field) => field.name === fieldName) &&
    existing.fields[fieldName] === undefined &&
    !templatePlaceholders(template).has(fieldName)
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
  await atomicWrite(existing.path, content);
  return { ...existing, fields: result.value };
}

function artifactPath(type: TemplateType, vaultRoot: string, project: string, id: string): string {
  return join(artifactDirectory(type, vaultRoot, project), `${id}.md`);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}
