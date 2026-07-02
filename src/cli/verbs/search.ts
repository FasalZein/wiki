/**
 * Search verb for ADR-0009. This is a thin wrapper over QMD: collection
 * registration, qmd query invocation, and stable stdout formatting only.
 *
 * Type filters use path-prefix filtering (`prds/`, `slices/`, `adrs/`,
 * `handoffs/`) rather than QMD frontmatter filters because the locked vault
 * layout already gives a cheap, stable template mapping. If QMD JSON later
 * exposes richer frontmatter, this can move into runQuery.
 */

import { join } from "node:path";

import { listCollections, QmdError, runQuery, type QmdResult } from "../../integrations/qmd";
import { resolveSharedQmdCommand } from "../../integrations/project-index";
import { openArtifact } from "../../artifacts/artifact-file";
import { artifactFolder, projectPath } from "../../artifacts/paths";
import { loadStructure, type Structure } from "../../artifacts/registry";
import { recentArtifacts, RECENT_LIMIT, type RecentArtifact } from "../../artifacts/recent";
import { assertProjectStructure, listProjects, loadProjectConfig, type ProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { TemplateType } from "../../schema/load";
import { classifyIntent } from "../../search/intent";
import { buildStructuredQuery } from "../../search/query-builder";
import { booleanValue, parseCommand, stringValue } from "../parse";
import { emitJsonArray, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";

// qmd ranks and truncates to a default window (20 for --json) before we can
// filter by artifact folder. When a --type filter is active we over-fetch so
// matching artifacts that rank below that window aren't silently dropped.
const TYPE_FILTER_FETCH = 50;

export async function handleSearch(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "type", "since"], [], ["explain", "no-refresh", "recent"]);
  const query = parsed.positionals[0]?.trim();
  if (query === undefined || query.length === 0) {
    console.error("missing required field: query");
    return { code: 1 };
  }
  const project = stringValue(parsed.values, "project");
  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  const allowedTypes = Object.keys(structure.kinds) as TemplateType[];
  const type = parseSearchType(stringValue(parsed.values, "type"), allowedTypes);
  if (type === null) {
    console.error(`invalid type: expected ${allowedTypes.join(", ")}`);
    return { code: 1 };
  }
  const explain = booleanValue(parsed.values, "explain");
  // PRD-0018: search is read-only by default now, so --no-refresh is the default
  // and the flag is an accepted no-op. Kept parseable so existing invocations and
  // scripts that still pass it don't error.
  // ponytail: no-op flag retained for back-compat; drop it in a later cleanup if usage dies.

  // Recency path: --recent, --since, or a temporal query ("what changed recently")
  // orders artifacts by mtime off disk — no qmd ranking. Reuses status's
  // recent-artifacts list so "recent" means the same thing in both verbs.
  const sinceRaw = stringValue(parsed.values, "since");
  let since: number | undefined;
  if (sinceRaw !== undefined) {
    // Require a strict ISO `YYYY-MM-DD` (optionally with a time): `new Date("1")`
    // or `new Date("june")` parse to something lenient and silently filter wrong.
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(sinceRaw)) {
      console.error(`invalid --since date: ${sinceRaw} (use ISO format, e.g. 2026-06-01)`);
      return { code: 1 };
    }
    const parsedDate = new Date(sinceRaw).getTime();
    if (Number.isNaN(parsedDate)) {
      console.error(`invalid --since date: ${sinceRaw} (use ISO format, e.g. 2026-06-01)`);
      return { code: 1 };
    }
    if (parsedDate > Date.now()) {
      console.error(`note: --since ${sinceRaw} is in the future — nothing is newer, so results will be empty.`);
    }
    since = parsedDate;
  }
  const recency = booleanValue(parsed.values, "recent") || since !== undefined || classifyIntent(query) === "temporal";

  // Resolve the target projects: one when --project is given, else the whole vault.
  let targetProjects: string[];
  if (project === undefined) {
    targetProjects = await listProjects(vaultRoot);
    if (targetProjects.length === 0) {
      console.error("no projects exist yet — create one with: wiki project create <name>");
      return { code: 10 };
    }
  } else {
    const projPath = projectPath(vaultRoot, project);
    try {
      await loadProjectConfig(projPath);
    } catch (error) {
      if (error instanceof ProjectConfigError) {
        console.error(await projectErrorMessage(vaultRoot, project));
        return { code: 10 };
      }
      throw error;
    }
    targetProjects = [project];
  }

  if (recency) {
    return handleRecency(vaultRoot, targetProjects, { type, since }, structure);
  }

  try {
    // Load every targeted project's config first so we can resolve a single qmd
    // binary before touching any collection. A vault-wide
    // query registers/updates/queries all collections in one pass, so they must
    // share one binary — otherwise we'd register with one qmd and query with
    // another. An explicit QMD_COMMAND pins it; otherwise every targeted project
    // must agree, or we reject with an actionable error (ADR-0027 follow-up).
    const configs: Array<readonly [string, ProjectConfig]> = [];
    for (const proj of targetProjects) {
      const projPath = projectPath(vaultRoot, proj);
      await assertProjectStructure(projPath, structure);
      configs.push([proj, await loadProjectConfig(projPath)]);
    }

    const resolution = resolveSharedQmdCommand(configs);
    if ("divergent" in resolution) {
      console.error(divergenceMessage("qmd_command", resolution.divergent, "set QMD_COMMAND to pin one binary"));
      return { code: 10 };
    }
    const qmdCommand = resolution.command;

    // PRD-0018: search is a pure read against whatever `wiki sync` last produced.
    // One `qmd collection list` up front tells us which collections exist; we
    // query only those — no per-query refresh, no auto-register. An absent
    // collection was never synced, so we warn-and-skip to stderr (never a silent
    // empty, never a silent auto-register of an unembedded collection). Per the
    // SLICE-0108 spike a present-but-unembedded collection still yields lexical
    // hits, so "present in the list" is the only gate to query it.
    //
    // collection name -> base directory, so a qmd://<collection>/<rel> URI can be
    // resolved back to a file on disk for frontmatter enrichment.
    const registered = new Set(await listCollections(qmdCommand));
    const collectionBases = new Map<string, string>();
    const collections: string[] = [];
    for (const [proj] of configs) {
      if (!registered.has(proj)) {
        console.error(`skipping ${proj}: never synced — run: wiki sync --project ${proj}`);
        continue;
      }
      collections.push(proj);
      collectionBases.set(proj, projectPath(vaultRoot, proj));
    }

    if (collections.length === 0) {
      console.error("no synced collections to search — run: wiki sync");
      await writeResults([], collectionBases, structure);
      return { code: 0 };
    }

    // Build structured query document instead of passing raw text
    const intent = classifyIntent(query);
    const queryDocument = buildStructuredQuery(query, { intent, project });
    const results = filterByType(
      await runQuery(qmdCommand, queryDocument, collections, {
        explain,
        limit: type === undefined ? undefined : TYPE_FILTER_FETCH,
      }),
      type,
      structure,
    );
    await writeResults(results, collectionBases, structure);
    return { code: 0 };
  } catch (error) {
    if (error instanceof QmdError) {
      console.error(error.summary);
      return { code: 10 };
    }
    throw error;
  }
}

function parseSearchType(value: string | undefined, allowedTypes: readonly TemplateType[]): TemplateType | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return allowedTypes.includes(value as TemplateType) ? (value as TemplateType) : null;
}

/** Build an actionable error naming which projects pin which value, plus the fix and the --project escape hatch. */
function divergenceMessage(field: string, pairs: ReadonlyArray<readonly [string, string]>, fix: string): string {
  const groups = new Map<string, string[]>();
  for (const [proj, value] of pairs) {
    const list = groups.get(value) ?? [];
    list.push(proj);
    groups.set(value, list);
  }
  const lines = [...groups.entries()].map(([value, projects]) => `  ${value}: ${projects.join(", ")}`);
  return `vault-wide search needs a single ${field}, but projects disagree:\n${lines.join("\n")}\nFix: ${fix}, or narrow with --project <name>.`;
}

function filterByType(results: QmdResult[], type: TemplateType | undefined, structure: Structure): QmdResult[] {
  if (type === undefined) {
    return results;
  }
  // qmd returns paths as "qmd://<collection>/<path>" URIs; the artifact folder is
  // the first path segment within the collection (e.g. qmd://rift/docs/DOC-0017.md).
  const prefix = `/${artifactFolder(type, structure)}/`;
  return results.filter((result) => uriPath(result.path).startsWith(prefix));
}

function uriPath(path: string): string {
  try {
    return new URL(path).pathname;
  } catch {
    return path;
  }
}

type EnrichedHit = {
  id: string;
  kind: string;
  title: string;
  path: string;
  score: string;
  snippet: string;
};

async function writeResults(results: QmdResult[], collectionBases: Map<string, string>, structure: Structure): Promise<void> {
  // SLICE-0092: group hits one line per artifact (qmd returns multiple chunks of
  // the same file) and enrich each with id/kind/title from frontmatter. --json
  // emits the same shape as an array; empty prints a no-results line in human
  // mode and a valid [] in json mode.
  emitHits(await enrichHits(results, collectionBases, structure));
}

/** Shared terminal: same shape for the qmd path and the recency path. */
function emitHits(hits: EnrichedHit[]): void {
  if (jsonEnabled()) {
    emitJsonArray(hits);
    return;
  }
  if (hits.length === 0) {
    process.stdout.write("no results\n");
    return;
  }
  process.stdout.write(hits.map(formatHit).join("\n") + "\n");
}

/**
 * SLICE-0093: the temporal/recency path. Orders artifacts by mtime off disk
 * (reusing status's recentArtifacts) instead of qmd ranking; --since filters to
 * files modified at/after a date; --type narrows to one kind. Score is blank —
 * there is no relevance score, only recency.
 */
async function handleRecency(
  vaultRoot: string,
  targetProjects: string[],
  opts: { type: TemplateType | undefined; since: number | undefined },
  structure: Structure,
): Promise<CliResult> {
  let artifacts: RecentArtifact[] = [];
  for (const proj of targetProjects) {
    artifacts.push(...(await recentArtifacts(vaultRoot, projectPath(vaultRoot, proj), structure)));
  }
  artifacts.sort((a, b) => b.mtime - a.mtime);
  if (opts.since !== undefined) {
    const since = opts.since;
    artifacts = artifacts.filter((a) => a.mtime >= since);
  }
  if (opts.type !== undefined) {
    // rel is projects/<proj>/<folder>/...; match the folder segment exactly so a
    // kind name appearing elsewhere in the path can't pull in the wrong artifacts.
    const folder = artifactFolder(opts.type, structure);
    artifacts = artifacts.filter((a) => a.rel.split(/[\\/]/).includes(folder));
  }
  const hits: EnrichedHit[] = [];
  for (const artifact of artifacts.slice(0, RECENT_LIMIT)) {
    hits.push(await recencyHit(artifact.full, artifact.rel, structure));
  }
  emitHits(hits);
  return { code: 0 };
}

/** Build an EnrichedHit for a recency result: id/kind/title from frontmatter (or
 *  filename/folder fallback), blank score and snippet (recency carries neither). */
async function recencyHit(filePath: string, rel: string, structure: Structure): Promise<EnrichedHit> {
  const { id, kind, title } = await readMeta(rel, filePath, structure);
  return { id, kind, title, path: filePath, score: "", snippet: "" };
}

/** Collapse per-file chunks to one hit each (highest-ranked wins; qmd ranks desc)
 *  and enrich with id/kind/title read from the resolved file's frontmatter. */
async function enrichHits(results: QmdResult[], collectionBases: Map<string, string>, structure: Structure): Promise<EnrichedHit[]> {
  const seen = new Set<string>();
  const hits: EnrichedHit[] = [];
  for (const result of results) {
    const filePath = resolveFilePath(result.path, collectionBases);
    const dedupKey = filePath ?? result.path;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const { id, kind, title } = await readMeta(result.path, filePath, structure);
    hits.push({
      id,
      kind,
      title,
      path: result.path,
      score: result.score,
      snippet: result.snippet.replaceAll(/\s*\n\s*/g, " ").trim(),
    });
  }
  return hits;
}

/** Map a qmd://<collection>/<rel> URI (or a raw filesystem path) to a file on
 *  disk; null when the collection is unknown. */
function resolveFilePath(path: string, collectionBases: Map<string, string>): string | null {
  if (path.startsWith("qmd://")) {
    const rest = path.slice("qmd://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    const collection = rest.slice(0, slash);
    const rel = rest.slice(slash + 1);
    const base = collectionBases.get(collection);
    return base === undefined ? null : join(base, rel);
  }
  return path; // already a filesystem path
}

/** id/kind/title from frontmatter when the file is readable, else a filename/
 *  folder fallback (id from the basename stem, kind from the parent folder). */
async function readMeta(uri: string, filePath: string | null, structure: Structure): Promise<{ id: string; kind: string; title: string }> {
  const segments = uriPath(uri).split(/[\\/]/).filter((s) => s.length > 0);
  const fileName = segments[segments.length - 1] ?? "";
  const folder = segments[segments.length - 2] ?? "";
  const kind = structure.artifactTypeForVaultPath(`projects/x/${folder}/${fileName}`) ?? folder;
  // Filename is ID-slug.md where ID is PREFIX-NNNN; fall back to that id shape,
  // else the whole basename stem.
  const stem = fileName.replace(/\.md$/, "");
  let id = /^[A-Za-z]+-\d+/.exec(stem)?.[0] ?? stem;
  let title = "";
  if (filePath !== null) {
    try {
      const af = await openArtifact(filePath);
      const fmId = af.field("id");
      if (fmId !== undefined && fmId.length > 0) id = fmId;
      const fmTitle = af.field("title");
      if (fmTitle !== undefined) title = fmTitle;
    } catch {
      // file not on disk (e.g. stale index) — keep the filename/folder fallback
    }
  }
  return { id, kind, title };
}

function formatHit(hit: EnrichedHit): string {
  return `${hit.id}\t${hit.kind}\t${hit.title}\t${hit.score}\t${hit.snippet}`;
}
