/**
 * Thin QMD CLI integration. Retrieval is delegated entirely to QMD; this module
 * only translates wiki's intent into subprocess calls.
 *
 * QMD command resolution is owned by the caller: QMD_COMMAND env, then
 * _project.md qmd_command, then default `qmd`.
 *
 * Collection existence parses exact names out of `qmd collection list` output.
 * Names are read from the stable `qmd://<name>/` URI token each entry carries,
 * not the human-readable leading column, so a spacing/indent/prefix change in
 * qmd's list format does not masquerade as 'collection never synced'.
 */

import { basename } from "node:path";

import { isRecord } from "../util";

export type QmdResult = {
  path: string;
  score: string;
  snippet: string;
};

export class QmdError extends Error {
  /**
   * One-line summary for CLI output: the first `Error:` line if present, else the
   * first non-empty line. qmd surfaces native-module/dlopen failures as a multi-line
   * Node stack trace; callers should print this, not the full `message`.
   */
  get summary(): string {
    const lines = this.message.split("\n");
    return lines.find((l) => l.startsWith("Error:")) ?? lines.find((l) => l.trim().length > 0) ?? this.message;
  }
}

// Each collection prints with a `qmd://<name>/` URI. Read the name out of that
// stable URI token (not the leading human-readable column, which can change
// spacing/indent across qmd versions). Anchoring on `qmd://` also keeps the
// membership check from false-positiving on a name that is a substring of
// another (e.g. "bayland" vs "bayland-portfolio-v1").
export function parseCollectionNames(output: string): string[] {
  return [...output.matchAll(/qmd:\/\/([^/\s)]+)\//g)].map((match) => match[1] ?? "").filter((name) => name.length > 0);
}

export async function listCollections(qmdCommand: string): Promise<string[]> {
  return parseCollectionNames(await runQmd(qmdCommand, ["collection", "list"]));
}

export async function addCollection(qmdCommand: string, name: string, path: string, glob: string): Promise<void> {
  await runQmd(qmdCommand, ["collection", "add", path, "--name", name, "--mask", glob]);
}

export async function ensureCollection(qmdCommand: string, name: string, path: string): Promise<void> {
  const collections = await listCollections(qmdCommand);
  if (!collections.includes(name)) {
    await addCollection(qmdCommand, name, path, "**/*.md");
  }
}

export async function updateCollection(qmdCommand: string, name: string, pull: boolean): Promise<void> {
  await runQmd(qmdCommand, pull ? ["update", "--pull", "-c", name] : ["update", "-c", name]);
}

/**
 * Shared refresh-before-query step: run an incremental (non-pull) update for
 * each already-ensured collection so a freshly written artifact is visible to
 * the next query. Used by both `search` and the dedup gate so freshness cannot
 * drift between the two query paths.
 */
export async function refreshCollections(qmdCommand: string, names: string[]): Promise<void> {
  for (const name of names) {
    await updateCollection(qmdCommand, name, false);
  }
}

export async function embedCollection(qmdCommand: string, name: string, force: boolean): Promise<void> {
  await runQmd(qmdCommand, force ? ["embed", "-f", "-c", name] : ["embed", "-c", name]);
}

export async function runQuery(
  qmdCommand: string,
  query: string,
  collections: string[],
  options?: { explain?: boolean; limit?: number },
): Promise<QmdResult[]> {
  const args = [
    "query",
    query,
    "--json",
    ...(options?.limit !== undefined ? ["-n", String(options.limit)] : []),
    ...(options?.explain === true ? ["--explain"] : []),
    ...collections.flatMap((collection) => ["--collection", collection]),
  ];
  const stdout = await runQmd(qmdCommand, args);
  if (stdout.trim().length === 0) {
    return [];
  }
  // ADR-0044: the sync-generated index.md rosters (per-project + vault root) are
  // in the collection but are not artifacts — drop them so they never surface as a
  // search hit or a dedup candidate. Excluded here (the shared query path) so both
  // `search` and the dedup gate stay clean without re-embedding the corpus.
  return parseQmdResults(stdout).filter((result) => basename(uriBasename(result.path)) !== "index.md");
}

/** Basename of a qmd://<collection>/<rel> URI or a raw filesystem path. */
function uriBasename(path: string): string {
  return path.startsWith("qmd://") ? path.slice("qmd://".length) : path;
}

async function runQmd(command: string, args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  } catch (error) {
    throw new QmdError(error instanceof Error ? error.message : String(error));
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    if (stdout.trim().length === 0) {
      throw new QmdError(stderr.length > 0 ? stderr : `qmd exited ${exitCode}`);
    }
    if (stderr.length > 0) {
      const warning = stderr.split("\n").find(l => l.startsWith("Error:")) ?? stderr.split("\n")[0] ?? "";
      if (warning.length > 0) console.error(`qmd warning: ${warning}`);
    }
  }
  return stdout;
}

export function parseQmdResults(stdout: string): QmdResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new QmdError(`qmd returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const path = stringField(item, "path") ?? stringField(item, "file") ?? stringField(item, "filename");
    if (path === undefined) {
      return [];
    }
    return [
      {
        path,
        score: scoreField(item),
        snippet: stringField(item, "snippet") ?? stringField(item, "text") ?? "",
      },
    ];
  });
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function scoreField(record: Record<string, unknown>): string {
  const value = record.score;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}
