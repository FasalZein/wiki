import { rename, writeFile } from "node:fs/promises";
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
  const path = join(artifactDirectory(input.type, input.vaultRoot, input.project), `${id}.md`);
  await atomicWrite(path, content);

  return {
    id,
    path,
    fields: result.value,
    body: content,
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}
