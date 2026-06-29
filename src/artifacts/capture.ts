import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { getVaultRoot } from "../config/vault";
import { readLinkedProject } from "../cli/repo-link";
import type { TemplateType } from "../schema/load";
import { loadStructure, type Structure } from "./registry";
import { buildIdIndex } from "./id-index";
import { mintAndWrite, slugifyTitle } from "./store";
import { artifactDirectory } from "./paths";

/**
 * Filing a written file into the vault yields one of three outcomes: `captured`
 * (it is an authoring artifact and the vault now holds it — `context` is an
 * advisory the caller may surface so the author need not run `wiki create`),
 * `warn` (it is artifact-shaped but cannot be filed — surfaced to the author,
 * never a silent drop and never a wrong-kind write), or null (an unrelated
 * write the caller ignores). Capture never throws on a filesystem fault; any
 * such fault becomes a `warn`, so the hook seam keeps its stdout contract.
 */
export type CaptureOutcome =
  | { outcome: "captured"; context: string }
  | { outcome: "warn"; warning: string }
  | null;

/**
 * The kind a written file declares in its OWN frontmatter, resolved via the
 * PER-VAULT structure (ADR-0038, SLICE-0116): a `template:` field naming a kind,
 * or an `id:` whose prefix resolves to one (e.g. PRD-0099 → prd). Resolved
 * against the SAME structure the write step uses (loadStructure(vaultRoot)), so a
 * vault's custom kind is recognized — not the bundled default, which would miss
 * any kind a custom wiki.json adds. Null when nothing it declares maps to a kind
 * the vault registers — the caller never guesses.
 */
function resolveKind(data: Record<string, unknown>, structure: Structure): TemplateType | null {
  const template = typeof data.template === "string" ? data.template : undefined;
  if (template !== undefined && structure.kinds[template] !== undefined) return template;
  const id = typeof data.id === "string" ? data.id : undefined;
  if (id !== undefined) {
    const kind = structure.typeForId(id);
    if (kind !== undefined) return kind;
  }
  return null;
}

function warn(path: string, reason: string): CaptureOutcome {
  return { outcome: "warn", warning: `authored but not captured: ${basename(path)} — ${reason}` };
}

/**
 * File a written file into the env-resolved vault when it is an authoring
 * artifact (ADR-0038 in-child capture). The bridge payload carries no
 * injected-skill identity, so the kind comes from the file's OWN frontmatter.
 *
 * - Not readable / not frontmatter / no `id`|`template` → null (ordinary write).
 * - Artifact-shaped (`id`/`template`) but no registered kind, or vault/project
 *   unresolvable, or a filesystem fault → `warn` (never throws past here).
 * - Otherwise filed verbatim under its kind via the canonical {@link mintAndWrite}
 *   seam (collision-safe), and the source draft is stamped with the assigned id.
 *
 * Idempotent: a draft whose declared id is already in the vault index is
 * reported `captured` without a second write. Kind-agnostic: it files whatever
 * kind the frontmatter declares, no hard-coded list beyond the registry.
 */
export async function captureArtifact(input: { path: string; cwd: string }): Promise<CaptureOutcome> {
  const { path, cwd } = input;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null; // not readable — nothing to capture
  }
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data;
    body = parsed.content;
  } catch {
    return null; // not parseable frontmatter
  }

  const declaredId = typeof data.id === "string" ? data.id : undefined;
  const declaredTemplate = typeof data.template === "string" ? data.template : undefined;
  // Not artifact-shaped (no id/template frontmatter) — an ordinary write, stay silent.
  if (declaredId === undefined && declaredTemplate === undefined) return null;

  // Resolve the vault and load ITS structure up front, so kind resolution rides
  // the same per-vault tree the write step uses (SLICE-0116): a custom-tree vault
  // recognizes its own custom kind, where the bundled default would not.
  let vaultRoot: string;
  try {
    vaultRoot = await getVaultRoot();
  } catch (error) {
    return warn(path, (error as Error).message);
  }
  let structure: Structure;
  try {
    structure = await loadStructure(vaultRoot);
  } catch (error) {
    return warn(path, (error as Error).message);
  }

  const kind = resolveKind(data, structure);
  if (kind === null) {
    const declared = declaredTemplate !== undefined ? `template '${declaredTemplate}'` : `id '${declaredId}'`;
    return warn(path, `declares ${declared}, which maps to no registered wiki kind — file it manually with 'wiki create <kind>'.`);
  }

  try {
    return await fileArtifact({ path, data, body, kind, declaredId, cwd, vaultRoot, structure });
  } catch (error) {
    // A filesystem fault (read-only draft, permissions, races past the retry)
    // must not crash the caller — surface it as a warning, never a silent drop.
    return warn(path, (error as Error).message);
  }
}

/** File the artifact via the shared seam, resolving the project from frontmatter
 *  or the linked repo. Vault + structure are already loaded by the caller. */
async function fileArtifact(args: {
  path: string;
  data: Record<string, unknown>;
  body: string;
  kind: TemplateType;
  declaredId: string | undefined;
  cwd: string;
  vaultRoot: string;
  structure: Structure;
}): Promise<CaptureOutcome> {
  const { path, data, body, kind, declaredId, cwd, vaultRoot, structure } = args;
  const project =
    typeof data.project === "string" && data.project.length > 0 ? data.project : (await readLinkedProject(cwd)) ?? undefined;
  if (project === undefined) {
    return warn(path, "no project (set frontmatter 'project' or link the repo).");
  }

  // Idempotent: a declared id already indexed in the vault means this draft is
  // already filed — report captured without a duplicate write.
  if (declaredId !== undefined && (await buildIdIndex(vaultRoot, project, structure)).has(declaredId)) {
    return { outcome: "captured", context: captureContext(kind, declaredId, true) };
  }

  const directory = artifactDirectory(kind, vaultRoot, project, structure);
  const today = new Date().toISOString().slice(0, 10);
  const artifact = await mintAndWrite({ type: kind, vaultRoot, project, structure }, (id) => {
    const title = typeof data.title === "string" && data.title.length > 0 ? data.title : id;
    const aliases = Array.isArray(data.aliases) ? [...new Set([id, ...data.aliases.map(String)])] : [id];
    const fields = { ...data, id, project, aliases, created: data.created ?? today, updated: today };
    return { path: `${directory}/${id}-${slugifyTitle(title)}.md`, content: matter.stringify(body, fields), fields };
  });

  // Stamp the source draft with the assigned id so a re-fire is idempotent.
  await writeFile(path, matter.stringify(body, { ...data, id: artifact.id, project }));
  return { outcome: "captured", context: captureContext(kind, artifact.id, false) };
}

/** Advisory injected after a capture so the author knows the artifact is filed. */
function captureContext(kind: TemplateType, id: string, existed: boolean): string {
  return existed
    ? `A wiki '${kind}' artifact (${id}) is already filed in the vault — no action needed.`
    : `Captured a wiki '${kind}' artifact into the vault as ${id} — no need to run 'wiki create'.`;
}
