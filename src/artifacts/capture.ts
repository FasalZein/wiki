import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { readFrontmatter, serializeArtifact } from "./artifact-file";

import { getVaultRoot } from "../config/vault";
import { readLinkedProject } from "../cli/repo-link";
import { loadProjectConfig, ProjectConfigError } from "../config/project";
import type { TemplateType } from "../schema/load";
import { loadStructure, type Structure } from "./registry";
import { buildIdIndex } from "./id-index";
import { mintAndWrite, slugifyTitle } from "./store";
import { artifactDirectory, projectPath } from "./paths";
import { DedupBlockedError, QmdError, runDedupGate } from "./dedup";

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
  | { outcome: "captured"; context: string; note?: string; id: string; path?: string }
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
    const parsed = readFrontmatter(content);
    data = parsed.data;
    body = parsed.body;
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
  //
  // Review follow-up (P2b): this index read is outside the per-project lock, so two
  // PostToolUse fires on the SAME unstamped draft can both miss it and each file a
  // copy. The lock cannot close this: it serializes id ALLOCATION (so the two get
  // DISTINCT ids — the duplicate-*id* invariant holds), but the draft is read before
  // the lock, so moving the check inside would still read the same pre-stamp id. The
  // durable idempotency guard is the post-file stamp below (a re-fire after the stamp
  // lands is correctly skipped); the dedup gate catches the rare double-content case.
  // Closing it fully needs a per-draft-path lock around read->decide->write, out of
  // scope here (concurrent fires on one exact path are not an observed pattern).
  if (declaredId !== undefined && (await buildIdIndex(vaultRoot, project, structure)).has(declaredId)) {
    return { outcome: "captured", context: captureContext(kind, declaredId, true), id: declaredId };
  }

  const directory = artifactDirectory(kind, vaultRoot, project, structure);
  const today = new Date().toISOString().slice(0, 10);
  // SLICE-0127: run the SAME advisory dedup gate `wiki create` uses, then file the
  // artifact. Capture NEVER blocks or prompts (it is a non-interactive hook): a
  // strong match files the artifact anyway and records an advisory note the caller
  // surfaces to stderr. The gate runs BEFORE mintAndWrite (unlocked): it shells out
  // to qmd, and the lock is reserved for the sub-millisecond allocate->write only
  // (a slow qmd call under the lock could let a waiter reclaim a live lock — review
  // follow-up P1). Dedup is advisory and files-anyway, so it needs no lock; the new
  // artifact is not yet on disk, so it cannot self-match the query.
  const dedupNote = await captureDedupNote({ kind, project, vaultRoot, structure, data, body });
  const artifact = await mintAndWrite(
    { type: kind, vaultRoot, project, structure },
    (id) => {
      const title = typeof data.title === "string" && data.title.length > 0 ? data.title : id;
      const aliases = Array.isArray(data.aliases) ? [...new Set([id, ...data.aliases.map(String)])] : [id];
      const fields = { ...data, id, project, aliases, created: data.created ?? today, updated: today };
      return { path: `${directory}/${id}-${slugifyTitle(title)}.md`, content: serializeArtifact(fields, body), fields };
    },
  );

  // Stamp the source draft with the assigned id so a re-fire is idempotent.
  await writeFile(path, serializeArtifact({ ...data, id: artifact.id, project }, body));
  const captured: CaptureOutcome = { outcome: "captured", context: captureContext(kind, artifact.id, false), id: artifact.id, path: artifact.path };
  return dedupNote !== undefined ? { ...captured, note: dedupNote } : captured;
}

/**
 * SLICE-0127: run the SAME advisory dedup gate `wiki create` uses (runDedupGate)
 * for the capture path, returning an advisory note on a STRONG match or undefined
 * otherwise. Capture must never block, prompt, or drop, so this only ever returns
 * a string to surface — it never throws past here: a weak match, no match, dedup
 * disabled for the kind, an unconfigured project, or any qmd fault all yield
 * undefined (file silently). Runs UNLOCKED, before mintAndWrite (review follow-up
 * P1): it shells out to qmd, and only the sub-millisecond allocate->write belongs
 * under the per-project lock.
 */
async function captureDedupNote(args: {
  kind: TemplateType;
  project: string;
  vaultRoot: string;
  structure: Structure;
  data: Record<string, unknown>;
  body: string;
}): Promise<string | undefined> {
  const { kind, project, vaultRoot, structure, data, body } = args;
  if (!structure.specFor(kind).dedup) return undefined;
  const projPath = projectPath(vaultRoot, project);
  let config;
  try {
    config = await loadProjectConfig(projPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) return undefined; // unconfigured project — skip dedup
    throw error;
  }
  // ADR-0044: the dedup query is title + summary (query-side only).
  const title = typeof data.title === "string" ? data.title : "";
  const summary = typeof data.summary === "string" ? data.summary : "";
  const query = [title, summary].filter((v) => v.length > 0).join(" ");
  try {
    await runDedupGate({ type: kind, project, projectPath: projPath, config, query, override: { kind: "none" }, structure });
    return undefined; // no match
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      // ADR-0044: only a strong SAME-kind match warrants a duplicate note.
      const strong = error.matches.find((match) => match.sameKind && match.strength === "strong");
      if (strong === undefined) return undefined; // no strong same-kind match — stay silent, file it
      return `possible duplicate of [[${strong.id}]] — review`;
    }
    if (error instanceof QmdError) return undefined; // qmd missing / never synced — best-effort
    throw error;
  }
}

/** Advisory injected after a capture so the author knows the artifact is filed. */
function captureContext(kind: TemplateType, id: string, existed: boolean): string {
  return existed
    ? `A wiki '${kind}' artifact (${id}) is already filed in the vault — no action needed.`
    : `Captured a wiki '${kind}' artifact into the vault as ${id} — no need to run 'wiki create'.`;
}
