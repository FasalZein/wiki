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

export async function readArtifact(input: ReadArtifactInput): Promise<Artifact> {
  const path = artifactPath(input.type, input.vaultRoot, input.project, input.id);
  const parsed = matter(await readFile(path, "utf8"));
  return {
    id: input.id,
    path,
    fields: parsed.data,
    body: parsed.content.trimStart(),
  };
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

function artifactPath(type: TemplateType, vaultRoot: string, project: string, id: string): string {
  return join(artifactDirectory(type, vaultRoot, project), `${id}.md`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}
