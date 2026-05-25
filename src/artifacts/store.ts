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
  await assertKnownField(input.type, input.field);
  const existing = await readArtifact(input);
  return writeFields(input, existing, {
    ...existing.fields,
    [input.field]: input.value,
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
  const id = await nextId(input.type, input.vaultRoot, input.project);
  const fields = applyDefaults(schema, {
    ...input.fields,
    id,
    project: input.project,
  });
  const result = validate(schema, fields);
  if (!result.ok) {
    throw new ArtifactValidationError(result.errors);
  }

  const templateFile = Bun.file(new URL(`../../templates/${input.type}.md`, import.meta.url));
  const content = renderArtifact(await templateFile.text(), result.value);
  const path = artifactPath(input.type, input.vaultRoot, input.project, id);
  await atomicWrite(path, content);

  return {
    id,
    path,
    fields: result.value,
    body: content,
  };
}

async function assertKnownField(type: TemplateType, fieldName: string): Promise<void> {
  const schema = await loadTemplate(type);
  if (!schema.fields.some((field) => field.name === fieldName)) {
    throw new ArtifactValidationError([{ field: fieldName, reason: "unknown field" }]);
  }
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

  const content = `${matter.stringify(existing.body, result.value)}\n`;
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
