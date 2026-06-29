import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";

import { bodySectionDrift } from "../../artifacts/body";
import { loadTemplate, normalizeInlineMaps, resolveTemplatePath } from "../../schema/load";
import { validate } from "../../schema/validate";
import { loadStructure } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { emitJson, jsonEnabled } from "../output";
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
  const structure = await loadStructure(vaultRoot);
  const rel = relative(vaultRoot, filePath);
  const type = structure.artifactTypeForVaultPath(rel);
  if (type === undefined) {
    console.error(`cannot infer artifact type from path: ${rel}`);
    console.error(`expected path under projects/<name>/<${structure.folders.join("|")}>/`);
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

  // SLICE-0088: a uniform {field,reason,expected} error list across schema and
  // body checks, so --json emits {ok,type,errors:[...]} and human mode prints
  // the same set with the expected detail appended.
  const errors: Array<{ field: string; reason: string; expected?: string }> = [
    ...(result.ok ? [] : result.errors),
    ...drift.missing.map((heading) => ({ field: "body", reason: "missing required section", expected: `## ${heading}` })),
    ...drift.unknown.map((heading) => ({ field: "body", reason: `unknown section (not in the ${type} template)`, expected: `## ${heading}` })),
  ];

  if (errors.length === 0) {
    if (jsonEnabled()) emitJson({ ok: true, type, errors: [] });
    else console.error(`valid ${type}: ${basename(filePath)}`);
    return { code: 0 };
  }

  if (jsonEnabled()) {
    emitJson({ ok: false, type, errors });
  } else {
    for (const error of errors) {
      console.error(`${error.field}: ${error.reason}${error.expected ? ` (expected: ${error.expected})` : ""}`);
    }
  }
  return { code: 1 };
}
