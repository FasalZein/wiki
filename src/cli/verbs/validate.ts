import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";

import { bodySectionDrift } from "../../artifacts/body";
import { loadTemplate, normalizeInlineMaps, resolveTemplatePath, type TemplateType } from "../../schema/load";
import { validate } from "../../schema/validate";
import { FOLDER_TO_TYPE } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";

export async function handleValidate(args: string[]): Promise<CliResult> {
  const filePath = args[0];
  if (filePath === undefined) {
    console.error("usage: wiki validate <file>");
    return { code: 1 };
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    console.error(`cannot read: ${filePath}`);
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const rel = relative(vaultRoot, filePath);
  const type = inferType(rel);
  if (type === undefined) {
    console.error(`cannot infer artifact type from path: ${rel}`);
    console.error("expected path under projects/<name>/<prds|slices|adrs|handoffs|docs>/");
    return { code: 1 };
  }

  const parsed = matter(content);
  const schema = await loadTemplate(type);
  const result = validate(schema, parsed.data);

  // Body-section contract (SLICE-0087): the compiled-structure rules enforced at
  // create time also apply after edits. Report required H2 sections that were
  // removed (and unknown ones added) using the same template as the source of truth.
  const templateBody = matter(normalizeInlineMaps(await Bun.file(resolveTemplatePath(`${type}.md`)).text())).content;
  const fieldNames = new Set(schema.fields.map((field) => field.name));
  const drift = bodySectionDrift(templateBody, fieldNames, parsed.content);

  if (result.ok && drift.missing.length === 0 && drift.unknown.length === 0) {
    console.error(`valid ${type}: ${basename(filePath)}`);
    return { code: 0 };
  }

  for (const error of result.ok ? [] : result.errors) {
    console.error(`${error.field}: ${error.reason}${error.expected ? ` (expected: ${error.expected})` : ""}`);
  }
  for (const heading of drift.missing) {
    console.error(`body: missing required section "## ${heading}"`);
  }
  for (const heading of drift.unknown) {
    console.error(`body: unknown section "## ${heading}" (not in the ${type} template)`);
  }
  return { code: 1 };
}

function inferType(rel: string): TemplateType | undefined {
  const parts = rel.split("/");
  const dir = parts[2];
  if (parts[0] === "projects" && parts.length >= 4 && dir !== undefined) {
    return FOLDER_TO_TYPE[dir];
  }
  return undefined;
}
