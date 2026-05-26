/**
 * Thin QMD CLI integration. Retrieval is delegated entirely to QMD; this module
 * only translates wiki's intent into subprocess calls.
 *
 * QMD command resolution is owned by the caller: QMD_COMMAND env, then
 * _project.md qmd_command, then default `qmd`.
 * Research path resolution is owned by project config: _project.md research_path,
 * then default `~/.pi/artifacts/research` with ~ expansion.
 *
 * Collection existence currently uses a substring search over
 * `qmd collection list` output. This is intentionally simple but fragile if QMD
 * changes that human-readable output shape.
 */

export type QmdResult = {
  path: string;
  score: string;
  snippet: string;
};

export class QmdError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function listCollections(qmdCommand: string): Promise<string> {
  return runQmd(qmdCommand, ["collection", "list"]);
}

export async function addCollection(qmdCommand: string, name: string, path: string, glob: string): Promise<void> {
  await runQmd(qmdCommand, ["collection", "add", name, path, glob]);
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

export async function embedCollection(qmdCommand: string, name: string, force: boolean): Promise<void> {
  await runQmd(qmdCommand, force ? ["embed", "-f", "-c", name] : ["embed", "-c", name]);
}

export async function addContext(qmdCommand: string, collectionPath: string, description: string): Promise<void> {
  await runQmd(qmdCommand, ["context", "add", collectionPath, description]);
}

export async function runQuery(qmdCommand: string, query: string, collections: string[]): Promise<QmdResult[]> {
  const args = ["query", query, "--json", ...collections.flatMap((collection) => ["--collection", collection])];
  const stdout = await runQmd(qmdCommand, args);
  if (stdout.trim().length === 0) {
    return [];
  }
  return parseQmdResults(stdout);
}

export async function runStructuredQuery(
  qmdCommand: string,
  queryDocument: string,
  collections: string[],
  options?: { explain?: boolean },
): Promise<QmdResult[]> {
  const args = [
    "query",
    queryDocument,
    "--json",
    ...(options?.explain === true ? ["--explain"] : []),
    ...collections.flatMap((collection) => ["--collection", collection]),
  ];
  const stdout = await runQmd(qmdCommand, args);
  if (stdout.trim().length === 0) {
    return [];
  }
  return parseQmdResults(stdout);
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
    throw new QmdError(stderr.length > 0 ? stderr : `qmd exited ${exitCode}`);
  }
  return stdout;
}

function parseQmdResults(stdout: string): QmdResult[] {
  const parsed: unknown = JSON.parse(stdout);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
