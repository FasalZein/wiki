import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { QMDStore, UpdateProgress, UpdateResult } from "@tobilu/qmd";
import { canonicalPathProblem, inspectContainedPath } from "./paths.ts";
import { parseNoteText } from "./frontmatter.ts";

/** Caller supplies a complete capture of validated concepts, not a selected subset.
 * Report every invalid/unreadable concept in diagnostics; never silently omit it. */
export type QmdInventory = {
  concepts: readonly { path: string; markdown: string }[];
  diagnostics: readonly QmdDiagnostic[];
};
export type QmdDiagnostic = { path: string; message: string };
export type QmdDigest = { path: string; digest: string };
export type QmdTextCoverage =
  | { state: "complete"; inventory: QmdDigest[] }
  | { state: "incomplete"; diagnostics: QmdDiagnostic[] }
  | { state: "unavailable"; diagnostics: QmdDiagnostic[] };
export type QmdEmbeddingCoverage =
  | { state: "complete" }
  | { state: "pending"; contentHashes: number }
  | { state: "unavailable" };
export type QmdSyncResult =
  | { state: "successful"; textCoverage: Extract<QmdTextCoverage, { state: "complete" }>; embeddingCoverage: QmdEmbeddingCoverage; update: UpdateResult }
  | { state: "incomplete"; textCoverage: Extract<QmdTextCoverage, { state: "incomplete" }>; embeddingCoverage: QmdEmbeddingCoverage; update: UpdateResult }
  | { state: "unavailable"; code: "conflict" | "unavailable"; textCoverage: Extract<QmdTextCoverage, { state: "unavailable" }>; embeddingCoverage: { state: "unavailable" } };
/** models: preflighted local files. Text update never runs inference, but QMD counts
 * pending embeddings against the configured embedding model identity. */
export type QmdSyncOptions = { signal?: AbortSignal; onProgress?: (progress: UpdateProgress) => void; models?: QmdModels };
export type QmdLexResult =
  | { state: "successful"; matches: { path: string; markdown: string; score: number }[] }
  | { state: "unavailable"; diagnostics: QmdDiagnostic[] };

const DIRECTORY = ".wiki/search";
const COLLECTION = "concepts";
const PREFIX = "qmd://" + COLLECTION + "/";
function digest(markdown: string): string { return "sha256:" + createHash("sha256").update(markdown).digest("hex"); }
// QMD excludes build/dist/vendor directories unconditionally. Flat opaque names
// preserve all canonical identities without inheriting engine scan exclusions or filename limits.
function stagedId(relative: string): string { return createHash("sha256").update(relative).digest("hex") + ".md"; }
function readIdentities(root: string): Map<string, string> {
  const raw: unknown = JSON.parse(fs.readFileSync(checked(root, DIRECTORY + "/identities.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || !("version" in raw) || raw.version !== 1 || !("paths" in raw) || !Array.isArray(raw.paths)) throw new Error("Invalid staged identity mapping");
  const identities = new Map<string, string>();
  for (const row of raw.paths) {
    if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string" || !("path" in row) || typeof row.path !== "string" || conceptProblem(row.path) || row.id !== stagedId(row.path) || identities.has(row.id)) throw new Error("Invalid or duplicate staged identity");
    identities.set(row.id, row.path);
  }
  return identities;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function checked(root: string, relative: string): string {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new Error(inspected.problem.message);
  return inspected.full;
}
class IndexWriterBusyError extends Error {}
function acquire(root: string) {
  const directory = checked(root, DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const lock = checked(root, DIRECTORY + "/writer.lock");
  // Separate from the content mutation lock. Never guess whether another writer is stale.
  // The exclusive marker, not an open descriptor, owns this cooperative lock.
  try { fs.writeFileSync(lock, "", { flag: "wx" }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new IndexWriterBusyError(error.message);
    throw error;
  }
  return () => {
    const diagnostics: QmdDiagnostic[] = [];
    try { fs.unlinkSync(lock); } catch (error) { diagnostics.push({ path: lock, message: "Writer lock removal failed: " + message(error) + ". Lock may be retained; confirm no index writer is active, restore directory permissions, then remove only this lock and synchronize again" }); }
    return diagnostics;
  };
}
async function cleanup(store: QMDStore | undefined, release: (() => QmdDiagnostic[]) | undefined): Promise<QmdDiagnostic[]> {
  const diagnostics: QmdDiagnostic[] = [];
  try { await store?.close(); } catch (error) { diagnostics.push({ path: DIRECTORY, message: "SDK close failed: " + message(error) }); }
  if (release) diagnostics.push(...release());
  return diagnostics;
}
function unavailable(diagnostics: QmdDiagnostic[], code: "conflict" | "unavailable" = "unavailable"): Extract<QmdSyncResult, { state: "unavailable" }> {
  return { state: "unavailable", code, textCoverage: { state: "unavailable", diagnostics }, embeddingCoverage: { state: "unavailable" } };
}
async function open(root: string, models?: QmdModels): Promise<QMDStore> {
  const dbPath = checked(root, DIRECTORY + "/qmd.sqlite");
  for (const suffix of ["-wal", "-shm", "-journal"]) checked(root, DIRECTORY + "/qmd.sqlite" + suffix);
  // QMD 2.8.3 fixes its model cache from XDG_CACHE_HOME (else ~/.cache) at first import
  // and creates it before resolving even absolute local files. Bind cache and config to
  // vault-local derived state first. Process-wide: a one-shot CLI opens one vault.
  // QMD appends qmd/models (cache) and qmd (config) and mkdirs them recursively, which
  // follows symlinks. Validate every SDK-managed component and create the cache one
  // non-recursive level at a time, so an existing symlink or file fails closed.
  const cache = checked(root, DIRECTORY + "/sdk-cache");
  for (const relative of ["sdk-cache", "sdk-cache/qmd", "sdk-cache/qmd/models"]) {
    const full = checked(root, DIRECTORY + "/" + relative);
    try { fs.mkdirSync(full); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    // lstat: a symlink created after the check is not a directory.
    if (!fs.lstatSync(full).isDirectory()) throw new Error("Expected a directory for SDK cache: " + DIRECTORY + "/" + relative);
  }
  const config = checked(root, DIRECTORY + "/sdk-config");
  for (const relative of ["sdk-config", "sdk-config/qmd"]) {
    const stat = fs.lstatSync(checked(root, DIRECTORY + "/" + relative), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("Expected a directory for SDK config: " + DIRECTORY + "/" + relative);
  }
  process.env.XDG_CACHE_HOME = cache;
  process.env.XDG_CONFIG_HOME = config;
  // Lazy import keeps ordinary vault commands independent of native search dependencies.
  const { createStore } = await import("@tobilu/qmd");
  return createStore({ dbPath, config: { ...(models ? { models } : {}), collections: { [COLLECTION]: {
    path: checked(root, DIRECTORY + "/snapshots"), pattern: "**/*.md",
  } } } });
}
function conceptProblem(relative: string): string | undefined {
  const canonical = canonicalPathProblem(relative);
  if (canonical) return canonical.message;
  const parts = relative.split("/");
  const offset = parts[0] === "personal" ? 1 : parts[0] === "projects" ? 2 : -1;
  if (offset < 0 || parts.length !== offset + 2 || parts.some(p => p.startsWith(".") || ["assets", "node_modules"].includes(p)) ||
      !relative.endsWith(".md") || parts.at(-1) === "index.md" || parts.at(-1) === "log.md") {
    return "Expected a validated concept under personal/<folder> or projects/<project>/<folder>, excluding generated and operational files";
  }
  return undefined;
}

/** Model-free text update. Successful receipts attest only the captured input,
 * never filesystem freshness or embedding completion. The entire directory is derived. */
export async function syncQmdText(root: string, inventory: QmdInventory, options: QmdSyncOptions = {}): Promise<QmdSyncResult> {
  let release: (() => QmdDiagnostic[]) | undefined;
  let store: QMDStore | undefined;
  let result: QmdSyncResult | undefined;
  let code: "conflict" | "unavailable" = "unavailable";
  const failures: QmdDiagnostic[] = [];
  try {
    release = acquire(root);
    const manifest = checked(root, DIRECTORY + "/coverage.json");
    fs.rmSync(manifest, { force: true });
    const mapping = checked(root, DIRECTORY + "/identities.json");
    fs.rmSync(mapping, { force: true });
    options.signal?.throwIfAborted();
    const diagnostics = [...inventory.diagnostics];
    const concepts = new Map<string, string>();
    for (const concept of inventory.concepts) {
      const problem = conceptProblem(concept.path);
      if (problem) diagnostics.push({ path: concept.path, message: problem });
      else if (concepts.has(concept.path)) throw new Error("Duplicate concept path: " + concept.path);
      else if (Buffer.from(concept.markdown).toString("utf8") !== concept.markdown) throw new Error("Invalid Unicode Markdown: " + concept.path);
      else concepts.set(concept.path, concept.markdown);
    }
    // QMD scans this allowlisted capture, not the vault. Full bytes are written
    // every time: neither our adapter nor QMD gates content hashing on mtime/size.
    const snapshots = checked(root, DIRECTORY + "/snapshots");
    fs.rmSync(snapshots, { recursive: true, force: true });
    fs.mkdirSync(snapshots);
    const identities = new Map<string, string>();
    for (const [relative, markdown] of concepts) {
      const id = stagedId(relative);
      if (identities.has(id)) throw new Error("Staged identity collision: " + relative);
      identities.set(id, relative);
      const full = checked(root, DIRECTORY + "/snapshots/" + id);
      fs.writeFileSync(full, markdown, { flag: "wx" });
    }
    if (options.models) bindModels(options.models);
    store = await open(root, options.models);
    const update = await store.update({ collections: [COLLECTION], onProgress(progress) {
      options.signal?.throwIfAborted();
      const canonical = identities.get(progress.file);
      if (!canonical) throw new Error("Unknown staged progress identity: " + progress.file);
      options.onProgress?.({ ...progress, file: canonical });
      options.signal?.throwIfAborted();
    } });
    options.signal?.throwIfAborted();
    if (update.skipped) throw new Error("QMD skipped " + update.skipped + " captured concepts");
    const indexed: QmdDigest[] = [];
    for (const [relative, markdown] of concepts) {
      options.signal?.throwIfAborted();
      const body = await store.getDocumentBody(PREFIX + stagedId(relative));
      if (body !== markdown) throw new Error("Indexed Markdown differs from captured concept: " + relative);
      indexed.push({ path: relative, digest: digest(markdown) });
    }
    const status = await store.getStatus();
    if (status.totalDocuments !== concepts.size) throw new Error("Indexed document count differs from captured inventory");
    const embeddingCoverage: QmdEmbeddingCoverage = status.needsEmbedding > 0
      ? { state: "pending", contentHashes: status.needsEmbedding } : { state: "complete" };
    // Closing is part of successful synchronization, not an effect after publishing coverage.
    const completed = store;
    store = undefined;
    await completed.close();
    fs.writeFileSync(mapping, JSON.stringify({ version: 1, paths: [...identities].map(([id, canonical]) => ({ id, path: canonical })) }) + "\n", { flag: "wx" });
    if (diagnostics.length) result = { state: "incomplete", textCoverage: { state: "incomplete", diagnostics }, embeddingCoverage, update };
    else {
      indexed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      options.signal?.throwIfAborted();
      // Publish only after body comparison and SDK close; failed cleanup invalidates this receipt below.
      fs.writeFileSync(manifest, JSON.stringify({ version: 1, inventory: indexed }) + "\n", { flag: "wx" });
      result = { state: "successful", textCoverage: { state: "complete", inventory: indexed }, embeddingCoverage, update };
    }
  } catch (error) {
    if (error instanceof IndexWriterBusyError) code = "conflict";
    failures.push({ path: DIRECTORY, message: message(error) });
  }
  // Cleanup belongs to the same structured failure boundary, without replacing the primary error.
  failures.push(...await cleanup(store, undefined));
  const invalidate = () => {
    for (const file of ["coverage.json", "identities.json"]) {
      try { fs.rmSync(checked(root, DIRECTORY + "/" + file), { force: true }); }
      catch (error) { failures.push({ path: DIRECTORY + "/" + file, message: "Failed to invalidate derived state: " + message(error) + ". Do not trust retained coverage; repair permissions and synchronize again" }); }
    }
  };
  // Invalidate while still owning the lock, never after another writer can acquire it.
  if (failures.length && release) invalidate();
  const releaseFailures = release?.() ?? [];
  failures.push(...releaseFailures);
  if (releaseFailures.length) invalidate(); // Failed unlink retains our exclusive marker.
  return failures.length ? unavailable(failures, code) : result ?? unavailable([{ path: DIRECTORY, message: "Synchronization did not complete" }]);
}

/** Lexical operation only, not a freshness/coverage claim. Synchronize the full
 * current inventory first. This interface cannot start models or embeddings. */
export async function searchQmdLex(root: string, query: string, limit = 10): Promise<QmdLexResult> {
  let release: (() => QmdDiagnostic[]) | undefined;
  let store: QMDStore | undefined;
  let result: QmdLexResult | undefined;
  const failures: QmdDiagnostic[] = [];
  try {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Expected a positive integer lexical limit");
    release = acquire(root);
    const dbPath = checked(root, DIRECTORY + "/qmd.sqlite");
    if (!fs.existsSync(dbPath)) throw new Error("Text index unavailable; synchronize captured concepts first");
    const identities = readIdentities(root);
    store = await open(root);
    const results = await store.searchLex(query, { collection: COLLECTION, limit });
    const matches = [];
    for (const result of results) {
      if (!result.filepath.startsWith(PREFIX)) throw new Error("Unexpected indexed collection identity");
      const relative = identities.get(result.filepath.slice(PREFIX.length));
      if (!relative) throw new Error("Unmapped indexed concept identity: " + result.filepath);
      const markdown = await store.getDocumentBody(result.filepath);
      if (markdown === null) throw new Error("Missing indexed result body: " + relative);
      matches.push({ path: relative, markdown, score: result.score });
    }
    result = { state: "successful", matches };
  } catch (error) {
    failures.push({ path: DIRECTORY, message: message(error) });
  }
  failures.push(...await cleanup(store, release));
  return failures.length ? { state: "unavailable", diagnostics: failures } : result ?? { state: "unavailable", diagnostics: [{ path: DIRECTORY, message: "Lexical query did not complete" }] };
}

/** Explicit local model files from .wiki/config.json search.models. Initialization leaves them unset. */
export type QmdModelRole = "embed" | "generate" | "rerank";
export type QmdModels = Partial<Record<QmdModelRole, string>>;
export type QmdReadyModels<R extends QmdModelRole> = Record<R, string> & QmdModels;
export type QmdReadiness<R extends QmdModelRole> =
  | { state: "ready"; models: QmdReadyModels<R> }
  | { state: "unavailable"; diagnostics: QmdDiagnostic[] };
export const FAST_ROLES = ["embed"] as const;
export const DEEP_ROLES = ["embed", "generate", "rerank"] as const;
const GGUF_MAGIC = "GGUF";

/** Preflight before any SDK model use so QMD's default resolver cannot download or call hosted inference. */
export function qmdModelReadiness<R extends QmdModelRole>(root: string, roles: readonly R[]): QmdReadiness<R> {
  const diagnostics: QmdDiagnostic[] = [];
  let configured: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(checked(root, ".wiki/config.json"), "utf8"));
    const search = typeof raw === "object" && raw !== null && "search" in raw ? raw.search : undefined;
    const models = typeof search === "object" && search !== null && "models" in search ? search.models : undefined;
    if (search !== undefined && (typeof search !== "object" || search === null || Array.isArray(search)) || models !== undefined && (typeof models !== "object" || models === null || Array.isArray(models))) {
      return { state: "unavailable", diagnostics: [{ path: ".wiki/config.json", message: "search.models must be an object of local model file paths" }] };
    }
    configured = (models ?? {}) as Record<string, unknown>;
  } catch (error) { return { state: "unavailable", diagnostics: [{ path: ".wiki/config.json", message: message(error) }] }; }
  const models: QmdModels = {};
  for (const role of DEEP_ROLES) {
    const value = configured[role];
    const where = ".wiki/config.json#search.models." + role;
    if (value === undefined) { if ((roles as readonly string[]).includes(role)) diagnostics.push({ path: where, message: "Not configured. Set an existing local GGUF file path; no model is downloaded and no hosted inference is used" }); continue; }
    if (typeof value !== "string" || !path.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) { diagnostics.push({ path: where, message: "Expected an absolute local file path, not a remote model URI" }); continue; }
    try {
      if (!fs.statSync(value).isFile()) throw new Error("not a regular file");
      const fd = fs.openSync(value, "r");
      try { const header = Buffer.alloc(4); fs.readSync(fd, header, 0, 4, 0); if (header.toString("latin1") !== GGUF_MAGIC) throw new Error("missing GGUF header"); }
      finally { fs.closeSync(fd); }
      models[role] = value;
    } catch (error) { if ((roles as readonly string[]).includes(role)) diagnostics.push({ path: where, message: "Model file unavailable (" + message(error) + "): " + value }); }
  }
  return diagnostics.length ? { state: "unavailable", diagnostics } : { state: "ready", models: models as QmdReadyModels<R> };
}
function bindModels(models: QmdModels) {
  // QMD 2.8.3 token chunking uses a process-global tokenizer that reads only
  // QMD_EMBED_MODEL, separate from the store LLM. Bind both before first SDK use.
  if (models.embed) process.env.QMD_EMBED_MODEL = models.embed;
}

export type QmdQuery = { type: "lex" | "vec" | "hyde"; query: string };
/** lexical: model-free degraded request after a model readiness failure. */
export type QmdFindRequest =
  | { mode: "fast"; question: string; terms?: string; models: QmdReadyModels<"embed"> }
  | { mode: "deep"; question: string; terms?: string; models: QmdReadyModels<"embed" | "generate" | "rerank"> }
  | { mode: "lexical"; requested: "fast" | "deep"; question: string; terms?: string; reason: QmdDiagnostic[] };
/** Every field comes from one captured revision; digest names those bytes. */
export type QmdRenderedMatch = { path: string; score: number; digest: string; title: string; description: string; excerpt: string };
/** Lexical-only results after vector/model failure. Never an exhaustive absence claim. */
export type QmdDegraded = { retrieval: "lexical"; exhaustive: false; reason: "models-unavailable" | "vector-failed"; diagnostics: QmdDiagnostic[] };
export type QmdFindResult =
  | { state: "successful"; mode: "fast" | "deep"; queries: QmdQuery[]; rerank: boolean; degraded?: QmdDegraded; matches: QmdRenderedMatch[];
      /** Omitted candidates: deleted/renamed, stale index, or moving target. Nonempty means text coverage is incomplete. */
      omitted: QmdDiagnostic[] }
  | { state: "unavailable"; code: "conflict" | "unavailable"; diagnostics: QmdDiagnostic[] };

function excerptOf(body: string, queries: readonly QmdQuery[]): string {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const terms = queries.filter(q => q.type === "lex").flatMap(q => q.query.toLowerCase().split(/\s+/)).filter(Boolean);
  return lines.find(line => terms.some(term => line.toLowerCase().includes(term))) ?? lines[0] ?? "";
}
/** Render from the captured revision and revalidate the current file before emitting.
 * Only vault files are reread; captured sources are never refetched. */
function render(root: string, relative: string | undefined, file: string, score: number, indexed: string | null, captured: ReadonlyMap<string, string>, queries: readonly QmdQuery[], omitted: QmdDiagnostic[]): QmdRenderedMatch | undefined {
  const markdown = relative === undefined ? undefined : captured.get(relative);
  if (relative === undefined || markdown === undefined) { omitted.push({ path: relative ?? file, message: "Indexed candidate is not in the current captured inventory (deleted, renamed or out of scope); omitted" }); return undefined; }
  if (indexed !== markdown) { omitted.push({ path: relative, message: "Indexed content differs from the captured revision; omitted rather than attaching an old excerpt" }); return undefined; }
  const expected = digest(markdown);
  let current: string | undefined;
  try {
    const stat = fs.lstatSync(checked(root, relative), { throwIfNoEntry: false });
    if (stat?.isFile()) current = "sha256:" + createHash("sha256").update(fs.readFileSync(checked(root, relative))).digest("hex");
  } catch { current = undefined; }
  if (current !== expected) { omitted.push({ path: relative, message: (current === undefined ? "Note disappeared" : "Note changed") + " after capture (moving target); omitted, not retried. Search again for its current revision" }); return undefined; }
  let title = "", description = "", body = markdown;
  try {
    const parsed = parseNoteText(markdown);
    body = parsed.body;
    if (typeof parsed.frontmatter.title === "string") title = parsed.frontmatter.title;
    if (typeof parsed.frontmatter.description === "string") description = parsed.frontmatter.description;
  } catch { /* Captured concepts are lint-valid; keep raw text if not. */ }
  return { path: relative, score, digest: expected, title, description, excerpt: excerptOf(body, queries) };
}
function vectorFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return !(error instanceof IndexWriterBusyError) && !signal?.aborted;
}

/** Fast: one typed lex/vec request, no expansion, no rerank. Deep: explicit expansion
 * and reranking. A fast miss never escalates. Synchronize text first; never embeds.
 * captured: the same inventory passed to syncQmdText; results render only from it. */
export async function findQmd(root: string, request: QmdFindRequest, captured: QmdInventory["concepts"], signal?: AbortSignal): Promise<QmdFindResult> {
  let release: (() => QmdDiagnostic[]) | undefined;
  let store: QMDStore | undefined;
  let result: QmdFindResult | undefined;
  let code: "conflict" | "unavailable" = "unavailable";
  const failures: QmdDiagnostic[] = [];
  try {
    signal?.throwIfAborted();
    if (!request.question.trim() || request.terms !== undefined && !request.terms.trim()) throw new Error("Expected a nonempty question and terms");
    release = acquire(root);
    if (!fs.existsSync(checked(root, DIRECTORY + "/qmd.sqlite"))) throw new Error("Text index unavailable; synchronize captured concepts first");
    const identities = readIdentities(root);
    const lexical: QmdQuery = { type: "lex", query: request.terms ?? request.question };
    let degraded: QmdDegraded | undefined = request.mode === "lexical" ? { retrieval: "lexical", exhaustive: false, reason: "models-unavailable", diagnostics: request.reason } : undefined;
    if (request.mode !== "lexical") bindModels(request.models);
    store = await open(root, request.mode === "lexical" ? undefined : request.models);
    let queries: QmdQuery[] = [lexical];
    let found: { file: string; score: number }[] | undefined;
    if (request.mode !== "lexical") {
      try {
        if (request.mode === "fast") queries = [lexical, { type: "vec", query: request.question }];
        else {
          const expanded = await store.expandQuery(request.question);
          // Native inference cannot be cancelled mid-call; stop at the next boundary.
          signal?.throwIfAborted();
          queries = [...(request.terms === undefined ? [] : [lexical]), ...expanded.map(q => ({ type: q.type, query: q.query }))];
        }
        found = await store.search({ queries, rerank: request.mode === "deep", collection: COLLECTION });
      } catch (error) {
        if (!vectorFailure(error, signal)) throw error;
        // Same engine, lexical index only: no second search stack.
        degraded = { retrieval: "lexical", exhaustive: false, reason: "vector-failed", diagnostics: [{ path: DIRECTORY, message: "Vector/model search failed: " + message(error) }] };
        queries = [lexical];
      }
    }
    found ??= (await store.searchLex(lexical.query, { collection: COLLECTION })).map(hit => ({ file: hit.filepath, score: hit.score }));
    signal?.throwIfAborted();
    const concepts = new Map(captured.map(c => [c.path, c.markdown]));
    const matches: QmdRenderedMatch[] = [], omitted: QmdDiagnostic[] = [];
    for (const match of found) {
      if (!match.file.startsWith(PREFIX)) throw new Error("Unexpected indexed collection identity");
      const relative = identities.get(match.file.slice(PREFIX.length));
      const rendered = render(root, relative, match.file, match.score, relative === undefined ? null : await store.getDocumentBody(match.file), concepts, queries, omitted);
      if (rendered) matches.push(rendered);
    }
    const rerank = request.mode === "deep" && !degraded;
    result = { state: "successful", mode: request.mode === "lexical" ? request.requested : request.mode, queries, rerank, ...(degraded ? { degraded } : {}), matches, omitted };
  } catch (error) {
    if (error instanceof IndexWriterBusyError) code = "conflict";
    failures.push({ path: DIRECTORY, message: message(error) });
  }
  failures.push(...await cleanup(store, release));
  // A signal during cleanup still withholds success.
  if (signal?.aborted && !failures.length) failures.push({ path: DIRECTORY, message: message(signal.reason) });
  return failures.length ? { state: "unavailable", code, diagnostics: failures } : result ?? { state: "unavailable", code, diagnostics: [{ path: DIRECTORY, message: "Find did not complete" }] };
}

export type QmdEmbedResult =
  | { state: "complete"; embeddingCoverage: { state: "complete" }; embedded: { docsProcessed: number; chunksEmbedded: number; errors: number } }
  | { state: "failed"; code: "conflict" | "unavailable"; embeddingCoverage: QmdEmbeddingCoverage; embedded?: { docsProcessed: number; chunksEmbedded: number; errors: number }; diagnostics: QmdDiagnostic[] };

/** Explicit synchronous embedding of current missing content hashes. No detached worker. */
export async function embedQmd(root: string, models: QmdReadyModels<"embed">, signal?: AbortSignal): Promise<QmdEmbedResult> {
  let code: "conflict" | "unavailable" = "unavailable";
  let release: (() => QmdDiagnostic[]) | undefined;
  let store: QMDStore | undefined;
  let embedded: { docsProcessed: number; chunksEmbedded: number; errors: number } | undefined;
  let coverage: QmdEmbeddingCoverage = { state: "unavailable" };
  const failures: QmdDiagnostic[] = [];
  try {
    signal?.throwIfAborted();
    release = acquire(root);
    if (!fs.existsSync(checked(root, DIRECTORY + "/qmd.sqlite"))) throw new Error("Text index unavailable; synchronize captured concepts first");
    bindModels(models);
    store = await open(root, models);
    // Progress is the SDK's only callback; aborting there stops between batches.
    const outcome = await store.embed({ onProgress() { signal?.throwIfAborted(); } });
    signal?.throwIfAborted();
    embedded = { docsProcessed: outcome.docsProcessed, chunksEmbedded: outcome.chunksEmbedded, errors: outcome.errors };
    const status = await store.getStatus();
    coverage = status.needsEmbedding > 0 ? { state: "pending", contentHashes: status.needsEmbedding } : { state: "complete" };
    if (outcome.errors > 0) failures.push({ path: DIRECTORY, message: outcome.errors + " embedding errors" });
    if (coverage.state !== "complete") failures.push({ path: DIRECTORY, message: "Embeddings remain pending after explicit embedding" });
  } catch (error) {
    if (error instanceof IndexWriterBusyError) code = "conflict";
    failures.push({ path: DIRECTORY, message: message(error) });
  }
  failures.push(...await cleanup(store, release));
  if (signal?.aborted && !failures.some(f => f.message === message(signal.reason))) failures.push({ path: DIRECTORY, message: message(signal.reason) });
  if (failures.length || !embedded || coverage.state !== "complete") return { state: "failed", code, embeddingCoverage: coverage.state === "complete" ? { state: "unavailable" } : coverage, ...(embedded ? { embedded } : {}), diagnostics: failures };
  return { state: "complete", embeddingCoverage: { state: "complete" }, embedded };
}
