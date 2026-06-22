/**
 * Search verb for ADR-0009. This is a thin wrapper over QMD: collection
 * registration, qmd query invocation, and stable stdout formatting only.
 *
 * Type filters use path-prefix filtering (`prds/`, `slices/`, `adrs/`,
 * `handoffs/`) rather than QMD frontmatter filters because the locked vault
 * layout already gives a cheap, stable template mapping. If QMD JSON later
 * exposes richer frontmatter, this can move into runQuery.
 */

import { ensureCollection, QmdError, runQuery, updateCollection, type QmdResult } from "../../integrations/qmd";
import { artifactFolder, projectPath } from "../../artifacts/paths";
import { ARTIFACTS } from "../../artifacts/registry";
import { assertProjectStructure, listProjects, loadProjectConfig, type ProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { TemplateType } from "../../schema/load";
import { classifyIntent } from "../../search/intent";
import { buildStructuredQuery } from "../../search/query-builder";
import { booleanValue, parseCommand, stringValue } from "../parse";
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

    const collections: string[] = [];
    for (const [proj] of configs) {
      await ensureCollection(qmdCommand, proj, projectPath(vaultRoot, proj));
      collections.push(proj);
    }
    if (booleanValue(parsed.values, "include-research")) {
      const researchPath = uniformConfigValue(configs.map(([proj, c]) => [proj, c.research_path] as const));
      if (researchPath === null) {
        console.error(divergenceMessage("research_path", configs.map(([proj, c]) => [proj, c.research_path] as const), "align research_path across projects"));
        return { code: 10 };
      }
      await ensureCollection(qmdCommand, "research", researchPath);
      collections.push("research");
    }

    // Auto-refresh collections before querying (unless --no-refresh)
    if (!noRefresh) {
      for (const collection of collections) {
        await updateCollection(qmdCommand, collection, false);
      }
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
    writeResults(results);
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

function writeResults(results: QmdResult[]): void {
  if (results.length === 0) {
    return;
  }
  process.stdout.write(results.map(formatResult).join("\n") + "\n");
}

function formatResult(result: QmdResult): string {
  return `${result.path}\t${result.score}\t${result.snippet.replaceAll(/\s*\n\s*/g, " ").trim()}`;
}
