/**
 * File-first authoring (ADR-0046 items 1-2).
 *
 * `wiki draft <kind>` prints a ready-to-fill skeleton — frontmatter carrying the
 * `template:`/`project:` stamps and every AUTHORABLE schema field (enums and
 * requiredness inline as comments; auto/CLI-owned fields omitted), plus the
 * authorable H2 body sections. Saved via the Write tool it is captured by the
 * hook; `wiki file <path>` files the same draft explicitly for hookless harnesses.
 *
 * The skeleton and the schema render from the same loaded Kind (authorableFlags +
 * authoredSections), so they can never drift.
 */

import { resolve } from "node:path";

import { authorableFlags, formatDefault, type AuthorableFlag } from "./create";
import { loadKind } from "../../artifacts/body";
import { captureArtifact } from "../../artifacts/capture";
import { DEFAULT_STRUCTURE, loadStructure, type Structure } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import { type TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";
import { readLinkedProject } from "../repo-link";
import { unknownMessage } from "../usage";

export async function handleDraft(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "title"]);
  const name = parsed.positionals[0];
  const { structure, vaultRoot } = await draftStructure();
  const template =
    name === undefined ? undefined : structure.kinds[name] !== undefined ? name : structure.bucketFor(name)?.bucket.template;
  if (template === undefined) {
    console.error(unknownMessage("artifact type", name ?? "", Object.keys(structure.kinds)));
    return { code: 1 };
  }
  const project = stringValue(parsed.values, "project") ?? (await readLinkedProject(process.cwd())) ?? "<project>";
  const skeleton = await renderDraft(template, { project, title: stringValue(parsed.values, "title"), vaultRoot });
  console.log(skeleton);
  return { code: 0 };
}

/**
 * Build the fill-me skeleton for a kind. Convention: required fields sit bare with
 * an inline `# required` comment (a field with a template default is pre-filled to
 * that default); OPTIONAL fields are commented out — so an untouched skeleton fills
 * to exactly the required set (the minimal valid artifact) with no stray null keys
 * to serialize, and the agent opts into an optional by uncommenting it. Enum choices
 * ride the same comment (`# required — one of: ...`), so nothing must be memorized.
 */
export async function renderDraft(type: TemplateType, opts: { project: string; title?: string; vaultRoot?: string }): Promise<string> {
  const [flags, kind] = await Promise.all([authorableFlags(type, opts.vaultRoot), loadKind(type, opts.vaultRoot)]);
  const lines: string[] = ["---", `template: ${type}`, `project: ${opts.project}`];
  for (const f of flags) {
    lines.push(draftFieldLine(f, opts.title));
  }
  lines.push("---", "");
  lines.push(`# ${opts.title ?? "<title>"}`);
  for (const section of kind.authoredSections()) {
    lines.push("", `## ${section.heading}`, "", `<!-- ${section.heading.toLowerCase()} -->`);
  }
  lines.push("");
  return lines.join("\n");
}

/** One frontmatter line for an authorable field, per the convention in {@link renderDraft}. */
function draftFieldLine(f: AuthorableFlag, title: string | undefined): string {
  const tag = `${f.required ? "required" : "optional"}${f.values !== undefined ? ` — one of: ${f.values.join(", ")}` : ""}`;
  if (f.field === "title" && title !== undefined) return `title: ${title}  # required`;
  if (f.default !== undefined) return `${f.field}: ${formatDefault(f.default)}  # ${tag}`;
  if (f.required) return `${f.field}:  # ${tag}`;
  return `# ${f.field}:  # ${tag}`;
}

/** Load the per-vault structure + vault root, falling back to the bundled default
 *  when no vault is configured (a draft is pure schema materialization — no vault
 *  write needed). The vaultRoot is threaded so a vault-shipped template resolves (F1). */
async function draftStructure(): Promise<{ structure: Structure; vaultRoot: string | undefined }> {
  try {
    const vaultRoot = await getVaultRoot();
    return { structure: await loadStructure(vaultRoot), vaultRoot };
  } catch {
    return { structure: DEFAULT_STRUCTURE, vaultRoot: undefined };
  }
}

/**
 * `wiki file <path>` — file a stamped draft explicitly (ADR-0046 item 2), a thin
 * wrapper over {@link captureArtifact} using the same cwd the write hook passes.
 * Prints the assigned id (stdout) + path (stderr) on capture; exits 1 with the
 * warning text when the file cannot be filed or is not a stamped draft.
 */
export async function handleFile(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const path = parsed.positionals[0];
  if (path === undefined) {
    console.error("usage: wiki file <path>");
    return { code: 1 };
  }
  const cwd = process.cwd();
  const outcome = await captureArtifact({ path: resolve(cwd, path), cwd });
  if (outcome === null) {
    console.error(`not a wiki draft: ${path} — needs frontmatter with a 'template:' or 'id:'. Run 'wiki draft <kind>' to scaffold one.`);
    return { code: 1 };
  }
  if (outcome.outcome === "warn") {
    console.error(outcome.warning);
    return { code: 1 };
  }
  if (jsonEnabled()) {
    emitJson({ id: outcome.id, path: outcome.path ?? null });
  } else {
    console.log(outcome.id);
    console.error(outcome.context);
    if (outcome.note !== undefined) console.error(outcome.note);
  }
  return { code: 0 };
}
