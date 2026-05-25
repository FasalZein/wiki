/**
 * Search verb for ADR-0009. This is a thin wrapper over QMD: collection
 * registration, qmd query invocation, and stable stdout formatting only.
 *
 * Type filters use path-prefix filtering (`prds/`, `slices/`, `decisions/`,
 * `handovers/`) rather than QMD frontmatter filters because the locked vault
 * layout already gives a cheap, stable template mapping. If QMD JSON later
 * exposes richer frontmatter, this can move into runQuery.
 */
import { join, relative, sep } from "node:path";

import { ensureCollection, QmdError, runQuery, type QmdResult } from "../../integrations/qmd";
import { assertProjectStructure, loadProjectConfig } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

const allowedTypes = ["prd", "slice", "decision", "handover"] as const;
type SearchType = (typeof allowedTypes)[number];

export async function handleSearch(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "type"]);
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
    console.error("invalid type: expected prd, slice, decision, or handover");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  try {
    await assertProjectStructure(projectPath);
    const config = await loadProjectConfig(projectPath);
    const qmdCommand = process.env.QMD_COMMAND ?? config.qmd_command;
    await ensureCollection(qmdCommand, project, projectPath);
    const results = filterByType(await runQuery(qmdCommand, query, [project]), projectPath, type);
    writeResults(results);
    return { code: 0 };
  } catch (error) {
    if (error instanceof QmdError) {
      console.error(error.message);
      return { code: 10 };
    }
    throw error;
  }
}

function parseSearchType(value: string | undefined): SearchType | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return allowedTypes.includes(value as SearchType) ? (value as SearchType) : null;
}

function filterByType(results: QmdResult[], projectPath: string, type: SearchType | undefined): QmdResult[] {
  if (type === undefined) {
    return results;
  }
  const prefix = `${folderForType(type)}${sep}`;
  return results.filter((result) => relative(projectPath, result.path).startsWith(prefix));
}

function folderForType(type: SearchType): string {
  if (type === "prd") {
    return "prds";
  }
  if (type === "slice") {
    return "slices";
  }
  if (type === "decision") {
    return "decisions";
  }
  return "handovers";
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
