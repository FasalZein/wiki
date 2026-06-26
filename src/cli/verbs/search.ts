/**
 * Search verb for ADR-0009. This is a thin wrapper over QMD: collection
 * registration, qmd query invocation, and stable stdout formatting only.
 *
 * Type filters use path-prefix filtering (`prds/`, `slices/`, `adrs/`,
 * `handoffs/`) rather than QMD frontmatter filters because the locked vault
 * layout already gives a cheap, stable template mapping. If QMD JSON later
 * exposes richer frontmatter, this can move into runQuery.
 */

import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureCollection, QmdError, refreshCollections, runQuery, type QmdResult } from "../../integrations/qmd";
import { artifactFolder, projectPath } from "../../artifacts/paths";
import { ARTIFACTS, FOLDER_TO_TYPE } from "../../artifacts/registry";
import { assertProjectStructure, listProjects, loadProjectConfig, type ProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { TemplateType } from "../../schema/load";
import { classifyIntent } from "../../search/intent";
import { buildStructuredQuery } from "../../search/query-builder";
import { booleanValue, parseCommand, stringValue } from "../parse";
import { emitJsonArray, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";

const allowedTypes: readonly TemplateType[] = Object.keys(ARTIFACTS) as TemplateType[];

// qmd ranks and truncates to a default window (20 for --json) before we can
// filter by artifact folder. When a --type filter is active we over-fetch so
// matching artifacts that rank below that window aren't silently dropped.
const TYPE_FILTER_FETCH = 50;

export async function handleSearch(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "type"], [], ["include-research", "explain", "no-refresh"]);
  const query = parsed.positionals[0]?.trim();
  if (query === undefined || query.length === 0) {
    console.error("missing required field: query");
    return { code: 1 };
  }
  const project = stringValue(parsed.values, "project");
  const type = parseSearchType(stringValue(parsed.values, "type"));
  if (type === null) {
    console.error(`invalid type: expected ${allowedTypes.join(", ")}`);
    return { code: 1 };
  }
  const explain = booleanValue(parsed.values, "explain");
  const noRefresh = booleanValue(parsed.values, "no-refresh");

  const vaultRoot = await getVaultRoot();

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

  try {
    // Load every targeted project's config first so we can resolve a single qmd
    // binary (and research path) before touching any collection. A vault-wide
    // query registers/updates/queries all collections in one pass, so they must
    // share one binary — otherwise we'd register with one qmd and query with
    // another. An explicit QMD_COMMAND pins it; otherwise every targeted project
    // must agree, or we reject with an actionable error (ADR-0027 follow-up).
    const configs: Array<readonly [string, ProjectConfig]> = [];
    for (const proj of targetProjects) {
      const projPath = projectPath(vaultRoot, proj);
      await assertProjectStructure(projPath);
      configs.push([proj, await loadProjectConfig(projPath)]);
    }

    const envQmd = process.env.QMD_COMMAND;
    let qmdCommand: string;
    if (envQmd !== undefined) {
      qmdCommand = envQmd;
    } else {
      const resolved = uniformConfigValue(configs.map(([proj, c]) => [proj, c.qmd_command] as const));
      if (resolved === null) {
        console.error(divergenceMessage("qmd_command", configs.map(([proj, c]) => [proj, c.qmd_command] as const), "set QMD_COMMAND to pin one binary"));
        return { code: 10 };
      }
      qmdCommand = resolved;
    }

    // collection name -> base directory, so a qmd://<collection>/<rel> URI can be
    // resolved back to a file on disk for frontmatter enrichment.
    const collectionBases = new Map<string, string>();
    const collections: string[] = [];
    for (const [proj] of configs) {
      const base = projectPath(vaultRoot, proj);
      await ensureCollection(qmdCommand, proj, base);
      collections.push(proj);
      collectionBases.set(proj, base);
    }
    if (booleanValue(parsed.values, "include-research")) {
      const researchPath = uniformConfigValue(configs.map(([proj, c]) => [proj, c.research_path] as const));
      if (researchPath === null) {
        console.error(divergenceMessage("research_path", configs.map(([proj, c]) => [proj, c.research_path] as const), "align research_path across projects"));
        return { code: 10 };
      }
      await ensureCollection(qmdCommand, "research", researchPath);
      collections.push("research");
      collectionBases.set("research", researchPath);
    }

    // Auto-refresh collections before querying (unless --no-refresh), via the
    // same shared helper the dedup gate uses so freshness cannot drift.
    if (!noRefresh) {
      await refreshCollections(qmdCommand, collections);
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
    );
    await writeResults(results, collectionBases);
    return { code: 0 };
  } catch (error) {
    if (error instanceof QmdError) {
      console.error(error.summary);
      return { code: 10 };
    }
    throw error;
  }
}

function parseSearchType(value: string | undefined): TemplateType | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return allowedTypes.includes(value as TemplateType) ? (value as TemplateType) : null;
}

/**
 * Return the shared value when every project agrees (or there is only one), else
 * null to signal divergence. Used to enforce a single qmd binary / research path
 * across a vault-wide search.
 */
function uniformConfigValue(pairs: ReadonlyArray<readonly [string, string]>): string | null {
  const first = pairs[0]?.[1];
  if (first === undefined) return null;
  return pairs.every(([, value]) => value === first) ? first : null;
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

function filterByType(results: QmdResult[], type: TemplateType | undefined): QmdResult[] {
  if (type === undefined) {
    return results;
  }
  // qmd returns paths as "qmd://<collection>/<path>" URIs; the artifact folder is
  // the first path segment within the collection (e.g. qmd://rift/docs/DOC-0017.md).
  const prefix = `/${artifactFolder(type)}/`;
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

async function writeResults(results: QmdResult[], collectionBases: Map<string, string>): Promise<void> {
  // SLICE-0092: group hits one line per artifact (qmd returns multiple chunks of
  // the same file) and enrich each with id/kind/title from frontmatter. --json
  // emits the same shape as an array; empty prints a no-results line in human
  // mode and a valid [] in json mode.
  const hits = await enrichHits(results, collectionBases);
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

/** Collapse per-file chunks to one hit each (highest-ranked wins; qmd ranks desc)
 *  and enrich with id/kind/title read from the resolved file's frontmatter. */
async function enrichHits(results: QmdResult[], collectionBases: Map<string, string>): Promise<EnrichedHit[]> {
  const seen = new Set<string>();
  const hits: EnrichedHit[] = [];
  for (const result of results) {
    const filePath = resolveFilePath(result.path, collectionBases);
    const dedupKey = filePath ?? result.path;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const { id, kind, title } = await readMeta(result.path, filePath);
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
async function readMeta(uri: string, filePath: string | null): Promise<{ id: string; kind: string; title: string }> {
  const segments = uriPath(uri).split(/[\\/]/).filter((s) => s.length > 0);
  const fileName = segments[segments.length - 1] ?? "";
  const folder = segments[segments.length - 2] ?? "";
  const kind = FOLDER_TO_TYPE[folder] ?? folder;
  // Filename is ID-slug.md where ID is PREFIX-NNNN; fall back to that id shape,
  // else the whole basename stem.
  const stem = fileName.replace(/\.md$/, "");
  let id = /^[A-Za-z]+-\d+/.exec(stem)?.[0] ?? stem;
  let title = "";
  if (filePath !== null) {
    try {
      const data = matter(await readFile(filePath, "utf8")).data;
      if (typeof data.id === "string" && data.id.length > 0) id = data.id;
      if (typeof data.title === "string") title = data.title;
    } catch {
      // file not on disk (e.g. stale index) — keep the filename/folder fallback
    }
  }
  return { id, kind, title };
}

function formatHit(hit: EnrichedHit): string {
  return `${hit.id}\t${hit.kind}\t${hit.title}\t${hit.score}\t${hit.snippet}`;
}
