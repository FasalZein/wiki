/**
 * Search verb for ADR-0009. This is a thin wrapper over QMD: collection
 * registration, qmd query invocation, and stable stdout formatting only.
 *
 * Type filters use path-prefix filtering (`prds/`, `slices/`, `adrs/`,
 * `handovers/`) rather than QMD frontmatter filters because the locked vault
 * layout already gives a cheap, stable template mapping. If QMD JSON later
 * exposes richer frontmatter, this can move into runQuery.
 */
import { join } from "node:path";

import { ensureCollection, QmdError, runQuery, updateCollection, type QmdResult } from "../../integrations/qmd";
import { artifactFolder } from "../../artifacts/paths";
import { ARTIFACTS } from "../../artifacts/registry";
import { assertProjectStructure, loadProjectConfig } from "../../config/project";
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
  if (project === undefined) {
    console.error("missing required field: project");
    return { code: 1 };
  }
  const type = parseSearchType(stringValue(parsed.values, "type"));
  if (type === null) {
    console.error(`invalid type: expected ${allowedTypes.join(", ")}`);
    return { code: 1 };
  }
  const explain = booleanValue(parsed.values, "explain");
  const noRefresh = booleanValue(parsed.values, "no-refresh");

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  try {
    await assertProjectStructure(projectPath);
    const config = await loadProjectConfig(projectPath);
    const qmdCommand = process.env.QMD_COMMAND ?? config.qmd_command;
    await ensureCollection(qmdCommand, project, projectPath);
    const collections = [project];
    if (booleanValue(parsed.values, "include-research")) {
      await ensureCollection(qmdCommand, "research", config.research_path);
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
      const errorLine = error.message.split("\n").find(l => l.startsWith("Error:")) ?? error.message.split("\n")[0] ?? error.message;
      console.error(errorLine);
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
