import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { QMDStore, UpdateProgress, UpdateResult } from "@tobilu/qmd";
import { canonicalPathProblem } from "./paths.ts";
import { isMapping } from "./frontmatter.ts";
import { containedPath as checked, readNoteRevision } from "./vault.ts";
import { planFind, selectMatches, type CurrentNoteReader, type FindHit } from "./find.ts";

/** Caller supplies a complete capture of validated concepts, not a selected subset.
 * Report every invalid/unreadable concept in diagnostics; never silently omit it. */
export type QmdInventory = {
  concepts: readonly { path: string; markdown: string }[];
  diagnostics: readonly QmdDiagnostic[];
};
export type QmdDiagnostic = { path: string; message: string };
export type QmdDigest = { path: string; digest: string };
export type QmdTextCoverage =
  /** inventoryCount and inventoryDigest summarize the receipt's sorted inventory; see inventoryDigest(). */
  | { state: "complete"; inventoryCount: number; inventoryDigest: string }
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
/** Documented JSON contract (README): sha256 over the UTF-8 bytes of JSON.stringify of the path-sorted
 * inventory, the exact array bytes coverage.json stores. A caller recomputes it from the receipt or vault. */
function inventoryDigest(sorted: readonly QmdDigest[]): string { return digest(JSON.stringify(sorted)); }
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
/** The environment of one request: run()'s env, which bin/wiki.js fills from process.env. */
export type QmdEnvironment = Readonly<Record<string, string | undefined>>;
/** The only place this module scopes process.env. QMD 2.8.3 and its native model layer read their settings
 * (HOME, XDG_CACHE_HOME, XDG_CONFIG_HOME, QMD_EMBED_MODEL, QMD_* tuning) from process.env, not from an argument.
 * So while body runs, process.env holds exactly the request environment; open() and bindModels() then set
 * the vault-local values on top of it. Afterwards every key is restored, so the host process keeps its own
 * environment. Limits: one scope per process at a time (concurrent scopes would see each other's values),
 * and values the SDK reads at its first import (its model cache directory) stay fixed for the process. */
async function withRequestEnvironment<T>(env: QmdEnvironment, body: () => Promise<T>): Promise<T> {
  const saved = { ...process.env }, wanted = { ...env };
  replaceProcessEnvironment(wanted);
  try { return await body(); }
  finally { replaceProcessEnvironment(saved); }
}
function replaceProcessEnvironment(next: QmdEnvironment): void {
  for (const key of Object.keys(process.env)) if (next[key] === undefined) delete process.env[key];
  for (const [key, value] of Object.entries(next)) if (value !== undefined) process.env[key] = value;
}
/** One operation's outcome at the shared failure boundary. value: undefined after a failure. */
type Attempt<V> = { value: V | undefined; code: "conflict" | "unavailable"; failures: QmdDiagnostic[] };
/** The SDK store of one operation: open binds models and environment; close ends it early (sync closes before publishing). */
type StoreSlot = { open(models: QmdModels | undefined): Promise<QMDStore>; close(): Promise<void> };
function unavailable(diagnostics: QmdDiagnostic[], code: "conflict" | "unavailable" = "unavailable"): Extract<QmdSyncResult, { state: "unavailable" }> {
  return { state: "unavailable", code, textCoverage: { state: "unavailable", diagnostics }, embeddingCoverage: { state: "unavailable" } };
}
function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
/** Creates one SDK cache level without following links; an existing symlink or file fails closed. */
function ensureCacheLevel(root: string, relative: string): void {
  const full = checked(root, DIRECTORY + "/" + relative);
  try { fs.mkdirSync(full); } catch (error) { if (!isErrorCode(error, "EEXIST")) throw error; }
  // lstat: a symlink created after the check is not a directory.
  if (!fs.lstatSync(full).isDirectory()) throw new Error("Expected a directory for SDK cache: " + DIRECTORY + "/" + relative);
}
/** SDK config levels may be absent, but an existing one must be a real directory. */
function assertConfigLevel(root: string, relative: string): void {
  const stat = fs.lstatSync(checked(root, DIRECTORY + "/" + relative), { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error("Expected a directory for SDK config: " + DIRECTORY + "/" + relative);
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
  for (const relative of ["sdk-cache", "sdk-cache/qmd", "sdk-cache/qmd/models"]) ensureCacheLevel(root, relative);
  const config = checked(root, DIRECTORY + "/sdk-config");
  for (const relative of ["sdk-config", "sdk-config/qmd"]) assertConfigLevel(root, relative);
  process.env.XDG_CACHE_HOME = cache;
  process.env.XDG_CONFIG_HOME = config;
  // Lazy import keeps ordinary vault commands independent of native search dependencies.
  const { createStore } = await import("@tobilu/qmd");
  return createStore({ dbPath, config: { ...(models ? { models } : {}), collections: { [COLLECTION]: {
    path: checked(root, DIRECTORY + "/snapshots"), pattern: "**/*.md",
  } } } });
}
/** Every active indexed body of the collection, keyed by staged id, in one query. Same rows as the
 * SDK's getDocumentBody(PREFIX + id), which QMD 2.8.3 answers with two full scans of documents per
 * call (it matches a computed virtual path). Layout per its store.js initializeDatabase:
 * documents(collection, path, hash, active, UNIQUE(collection, path)) and content(hash PRIMARY KEY, doc). */
function indexedBodies(store: QMDStore): Map<string, string> {
  return new Map(activeDocuments(store.internal.db, "main").filter(row => row.collection === COLLECTION).map(row => [row.path, row.doc]));
}
/** The only copy of the active-document read. schema: "main", or a database ATTACHed for inspection (doctor). */
function activeDocuments(db: QMDStore["internal"]["db"], schema: "main" | "inspected") {
  return db.prepare("SELECT d.id, d.collection, d.path, d.title, c.doc FROM " + schema + ".documents d JOIN " + schema + ".content c ON c.hash = d.hash WHERE d.active = 1")
    .all<{ id: number; collection: string; path: string; title: string; doc: string }>();
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

/** One request's hold on the vault's search index. The first operation takes the exclusive
 * writer lock and the session keeps it until close(), so a find or embed request synchronizes
 * text and then queries or embeds under one lock: no other writer can replace the index between.
 * Operations run one at a time. Each opens and closes its own SDK store, because synchronization
 * closes the store before it publishes receipts. The session owns the lock, the state files
 * (identities.json, coverage.json, snapshots, SQLite sidecars), staged ids and SDK internals.
 * Process-global effect: QMD 2.8.3 reads XDG_CACHE_HOME, XDG_CONFIG_HOME and QMD_EMBED_MODEL from
 * process.env, so each store open sets them inside the request scope (withRequestEnvironment). */
class SearchIndexSession {
  #release: (() => QmdDiagnostic[]) | undefined;
  #closed = false;
  /** Set once sync starts: its receipts are then only valid while this session holds the lock. */
  #synced = false;
  /** models: the preflighted local files that synchronization counts pending embeddings against. */
  readonly root: string;
  readonly models: QmdModels | undefined;
  constructor(root: string, models: QmdModels | undefined) { this.root = root; this.models = models; }
  #acquire(): void {
    if (this.#closed) throw new Error("Search index session is closed");
    this.#release ??= acquire(this.root);
  }
  #indexIdentities(): Map<string, string> {
    if (!fs.existsSync(checked(this.root, DIRECTORY + "/qmd.sqlite"))) throw new Error("Text index unavailable; synchronize captured concepts first");
    return readIdentities(this.root);
  }
  async #open(models: QmdModels | undefined): Promise<QMDStore> {
    if (models) bindModels(models);
    return open(this.root, models);
  }
  #invalidate(failures: QmdDiagnostic[]): void {
    for (const file of ["coverage.json", "identities.json"]) {
      try { fs.rmSync(checked(this.root, DIRECTORY + "/" + file), { force: true }); }
      catch (error) { failures.push({ path: DIRECTORY + "/" + file, message: "Failed to invalidate derived state: " + message(error) + ". Do not trust retained coverage; repair permissions and synchronize again" }); }
    }
  }
  /** The failure boundary every operation shares: a thrown error becomes one diagnostic (a busy
   * lock is a conflict), and an open SDK store closes afterwards without replacing the primary error. */
  async #attempt<V>(body: (store: StoreSlot) => Promise<V>): Promise<Attempt<V>> {
    const held: { store?: QMDStore } = {};
    const slot: StoreSlot = {
      open: async models => (held.store = await this.#open(models)),
      close: async () => { const store = held.store; held.store = undefined; await store?.close(); },
    };
    let value: V | undefined;
    let code: Attempt<V>["code"] = "unavailable";
    const failures: QmdDiagnostic[] = [];
    try { value = await body(slot); }
    catch (error) {
      if (error instanceof IndexWriterBusyError) code = "conflict";
      failures.push({ path: DIRECTORY, message: message(error) });
    }
    try { await held.store?.close(); } catch (error) { failures.push({ path: DIRECTORY, message: "SDK close failed: " + message(error) }); }
    return { value, code, failures };
  }
  /** Releases the lock. A failed unlink retains our exclusive marker, so receipts this session
   * published are invalidated. Only inSession calls it; it folds the failures into the request. */
  close(): QmdDiagnostic[] {
    this.#closed = true;
    const release = this.#release;
    this.#release = undefined;
    const failures = release?.() ?? [];
    if (failures.length && this.#synced) this.#invalidate(failures);
    return failures;
  }

  /** Model-free text update: replace the text index from a complete inventory. Successful receipts
   * attest only the captured input, never filesystem freshness or embedding completion. */
  async sync(inventory: QmdInventory, options: QmdSyncOptions = {}): Promise<QmdSyncResult> {
    const { value, code, failures } = await this.#attempt<QmdSyncResult>(async slot => {
      this.#acquire();
      this.#synced = true;
      const manifest = checked(this.root, DIRECTORY + "/coverage.json");
      fs.rmSync(manifest, { force: true });
      const mapping = checked(this.root, DIRECTORY + "/identities.json");
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
      const snapshots = checked(this.root, DIRECTORY + "/snapshots");
      fs.rmSync(snapshots, { recursive: true, force: true });
      fs.mkdirSync(snapshots);
      const identities = new Map<string, string>();
      for (const [relative, markdown] of concepts) {
        const id = stagedId(relative);
        if (identities.has(id)) throw new Error("Staged identity collision: " + relative);
        identities.set(id, relative);
        const full = checked(this.root, DIRECTORY + "/snapshots/" + id);
        fs.writeFileSync(full, markdown, { flag: "wx" });
      }
      const store = await slot.open(this.models);
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
      const bodies = indexedBodies(store);
      for (const [relative, markdown] of concepts) {
        options.signal?.throwIfAborted();
        const body = bodies.get(stagedId(relative)) ?? null;
        if (body !== markdown) throw new Error("Indexed Markdown differs from captured concept: " + relative);
        indexed.push({ path: relative, digest: digest(markdown) });
      }
      const status = await store.getStatus();
      if (status.totalDocuments !== concepts.size) throw new Error("Indexed document count differs from captured inventory");
      const embeddingCoverage: QmdEmbeddingCoverage = status.needsEmbedding > 0
        ? { state: "pending", contentHashes: status.needsEmbedding } : { state: "complete" };
      // Closing is part of successful synchronization, not an effect after publishing coverage.
      await slot.close();
      fs.writeFileSync(mapping, JSON.stringify({ version: 1, paths: [...identities].map(([id, canonical]) => ({ id, path: canonical })) }) + "\n", { flag: "wx" });
      if (diagnostics.length) return { state: "incomplete", textCoverage: { state: "incomplete", diagnostics }, embeddingCoverage, update };
      indexed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      options.signal?.throwIfAborted();
      // Publish only after body comparison and SDK close; failed cleanup invalidates this receipt below.
      fs.writeFileSync(manifest, JSON.stringify({ version: 1, inventory: indexed }) + "\n", { flag: "wx" });
      return { state: "successful", textCoverage: { state: "complete", inventoryCount: indexed.length, inventoryDigest: inventoryDigest(indexed) }, embeddingCoverage, update };
    });
    // Invalidate while still owning the lock, never after another writer can acquire it.
    if (failures.length && this.#release) this.#invalidate(failures);
    return failures.length ? unavailable(failures, code) : value ?? unavailable([{ path: DIRECTORY, message: "Synchronization did not complete" }]);
  }

  /** Lexical operation only, not a freshness/coverage claim. Cannot start models or embeddings. */
  async searchLex(query: string, limit = 10): Promise<QmdLexResult> {
    const { value, failures } = await this.#attempt<QmdLexResult>(async slot => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Expected a positive integer lexical limit");
      this.#acquire();
      const identities = this.#indexIdentities();
      const store = await slot.open(undefined);
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
      return { state: "successful", matches };
    });
    return failures.length ? { state: "unavailable", diagnostics: failures } : value ?? { state: "unavailable", diagnostics: [{ path: DIRECTORY, message: "Lexical query did not complete" }] };
  }
  /** Fast: one typed lex/vec request, no expansion, no rerank. Deep: explicit expansion
   * and reranking. A fast miss never escalates. Never embeds. captured: the inventory the
   * index was synchronized from; results render only from it. */
  async find(request: QmdFindRequest, captured: QmdInventory["concepts"], signal?: AbortSignal): Promise<QmdFindResult> {
    const { value, code, failures } = await this.#attempt<QmdFindResult>(async slot => {
      signal?.throwIfAborted();
      if (!request.question.trim() || request.terms !== undefined && !request.terms.trim()) throw new Error("Expected a nonempty question and terms");
      const limit = request.limit ?? QMD_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Expected a positive integer find limit");
      this.#acquire();
      const identities = this.#indexIdentities();
      const lexical: QmdQuery = { type: "lex", query: request.terms ?? request.question };
      let degraded: QmdDegraded | undefined = request.mode === "lexical" ? { retrieval: "lexical", exhaustive: false, reason: "models-unavailable", diagnostics: request.reason } : undefined;
      const store = await slot.open(request.mode === "lexical" ? undefined : request.models);
      let queries: QmdQuery[] = [lexical];
      let found: { file: string; score: number }[] | undefined;
      // The query must run against the index of this request's captured inventory. Another
      // cooperative sync can replace it between our sync and this lock; detect, never assume.
      const concepts = new Map(captured.map(c => [c.path, c.markdown]));
      const indexMismatch: QmdDiagnostic[] = [];
      const indexed = new Set(identities.values());
      // Read once under this request's lock: the same bodies serve this check and rendering below.
      const bodies = indexedBodies(store);
      for (const [relative, markdown] of concepts) {
        if (!indexed.has(relative)) indexMismatch.push({ path: relative, message: "Captured concept is missing from the queried index (replaced by another synchronization); text coverage incomplete. Search again" });
        else if (bodies.get(stagedId(relative)) !== markdown) indexMismatch.push({ path: relative, message: "Queried index holds a different revision than this request captured (replaced by another synchronization); text coverage incomplete. Search again" });
      }
      for (const relative of indexed) if (!concepts.has(relative)) indexMismatch.push({ path: relative, message: "Queried index holds a concept outside this request's captured inventory; text coverage incomplete. Search again" });
      signal?.throwIfAborted();
      if (request.mode !== "lexical") {
        // QMD 2.8.3 logs native model/context/query-embedding failures and returns null
        // embeddings; structured search then skips vector legs and resolves normally.
        // Observe the embeddings it received instead of relying on a thrown error.
        const llm = store.internal.llm;
        if (!llm) throw new Error("SDK store has no bound local model");
        let missingEmbeddings = 0;
        const embedBatch = llm.embedBatch.bind(llm);
        llm.embedBatch = async (texts, options) => {
          const embeddings = await embedBatch(texts, options);
          missingEmbeddings += texts.length - embeddings.filter(e => e?.embedding).length;
          return embeddings;
        };
        try {
          if (request.mode === "fast") queries = [lexical, { type: "vec", query: request.question }];
          else {
            const expanded = await store.expandQuery(request.question);
            // Native inference cannot be cancelled mid-call; stop at the next boundary.
            signal?.throwIfAborted();
            if (!expanded.some(q => q.query !== request.question)) throw new ExpansionFailedError("Deep query expansion produced no usable entries (" + expanded.length + " returned); expansion and reranking did not run");
            queries = [...(request.terms === undefined ? [] : [lexical]), ...expanded.map(q => ({ type: q.type, query: q.query }))];
          }
          // The final limit applies after literal merging and filters, so qmd's own result slice spans the whole collection.
          found = await store.search({ queries, rerank: request.mode === "deep", collection: COLLECTION, limit: Math.max(identities.size, 1) });
          if (missingEmbeddings) { found = undefined; throw new Error(missingEmbeddings + " query embeddings were not produced; QMD skipped those vector legs"); }
        } catch (error) {
          if (!vectorFailure(error, signal)) throw error;
          // Same engine, lexical index only: no second search stack.
          degraded = error instanceof ExpansionFailedError
            ? { retrieval: "lexical", exhaustive: false, reason: "expansion-failed", diagnostics: [{ path: DIRECTORY, message: message(error) }] }
            : { retrieval: "lexical", exhaustive: false, reason: "vector-failed", diagnostics: [{ path: DIRECTORY, message: "Vector/model search failed: " + message(error) }] };
          queries = [lexical];
        }
      }
      found ??= (await store.searchLex(lexical.query, { collection: COLLECTION, limit: Math.max(identities.size, 1) })).map(hit => ({ file: hit.filepath, score: hit.score }));
      signal?.throwIfAborted();
      const hits: FindHit[] = [], unmapped: string[] = [];
      for (const match of found) {
        if (!match.file.startsWith(PREFIX)) throw new Error("Unexpected indexed collection identity");
        const relative = identities.get(match.file.slice(PREFIX.length));
        if (relative === undefined) unmapped.push(match.file);
        else hits.push({ path: relative, score: match.score });
      }
      // readIdentities pins each id to stagedId(path), so a path's body is found by its staged id.
      const indexedByPath = new Map<string, string>();
      for (const relative of [...concepts.keys(), ...indexed]) {
        const body = bodies.get(stagedId(relative));
        if (body !== undefined) indexedByPath.set(relative, body);
      }
      const plan = planFind({ hits, unmapped, captured: concepts, indexed: indexedByPath, question: request.question, terms: request.terms, queries, scope: request.scope, type: request.type });
      const { matches, omitted } = selectMatches(plan, limit, currentNotes(this.root), () => signal?.throwIfAborted());
      const literals = plan.literals;
      const rerank = request.mode === "deep" && !degraded;
      return { state: "successful", mode: request.mode === "lexical" ? request.requested : request.mode, queries, rerank, ...(degraded ? { degraded } : {}), literals, limit, matches, omitted, indexMismatch } satisfies QmdFindResult;
    });
    // A signal during cleanup still withholds success.
    if (signal?.aborted && !failures.length) failures.push({ path: DIRECTORY, message: message(signal.reason) });
    return failures.length ? { state: "unavailable", code, diagnostics: failures } : value ?? { state: "unavailable", code, diagnostics: [{ path: DIRECTORY, message: "Find did not complete" }] };
  }
  /** Explicit synchronous embedding of current missing content hashes. No detached worker. */
  async embed(models: QmdReadyModels<"embed">, signal?: AbortSignal): Promise<QmdEmbedResult> {
    // Filled as embedding progresses: a later failure still reports what was embedded.
    const done: { embedded?: { docsProcessed: number; chunksEmbedded: number; errors: number }; coverage: QmdEmbeddingCoverage } = { coverage: { state: "unavailable" } };
    const problems: QmdDiagnostic[] = [];
    const attempt = await this.#attempt(async slot => {
      signal?.throwIfAborted();
      this.#acquire();
      if (!fs.existsSync(checked(this.root, DIRECTORY + "/qmd.sqlite"))) throw new Error("Text index unavailable; synchronize captured concepts first");
      const store = await slot.open(models);
      // Progress is the SDK's only callback; aborting there stops between batches.
      const outcome = await store.embed({ onProgress() { signal?.throwIfAborted(); } });
      signal?.throwIfAborted();
      done.embedded = { docsProcessed: outcome.docsProcessed, chunksEmbedded: outcome.chunksEmbedded, errors: outcome.errors };
      const status = await store.getStatus();
      done.coverage = status.needsEmbedding > 0 ? { state: "pending", contentHashes: status.needsEmbedding } : { state: "complete" };
      if (outcome.errors > 0) problems.push({ path: DIRECTORY, message: outcome.errors + " embedding errors" });
      if (done.coverage.state !== "complete") problems.push({ path: DIRECTORY, message: "Embeddings remain pending after explicit embedding" });
    });
    const failures = [...problems, ...attempt.failures];
    if (signal?.aborted && !failures.some(f => f.message === message(signal.reason))) failures.push({ path: DIRECTORY, message: message(signal.reason) });
    const { embedded, coverage } = done;
    if (failures.length || !embedded || coverage.state !== "complete") return { state: "failed", code: attempt.code, embeddingCoverage: coverage.state === "complete" ? { state: "unavailable" } : coverage, ...(embedded ? { embedded } : {}), diagnostics: failures };
    return { state: "complete", embeddingCoverage: { state: "complete" }, embedded };
  }
}
/** Runs one request in one session, then releases the lock. A failed release retains the lock, and
 * close() has invalidated every receipt this session's sync published. Each entry point passes its
 * own fold for that case, so the choice is explicit per entry point: a request that synchronized
 * reports an unavailable synchronization and drops its follow-on result (keeping that result's
 * failures as diagnostics), as before one session held the lock across sync and query. A request
 * without sync reports its operation unavailable. */
async function inSession<O>(root: string, models: QmdModels | undefined, env: QmdEnvironment, run: (session: SearchIndexSession) => Promise<O>, released: (outcome: O, release: QmdDiagnostic[]) => O): Promise<O> {
  return withRequestEnvironment(env, async () => {
    const session = new SearchIndexSession(root, models);
    const outcome = await run(session);
    const release = session.close();
    return release.length ? released(outcome, release) : outcome;
  });
}
/** The fold of a sync-led request. operation: the failures of its follow-on find or embed. */
function releasedSync(sync: QmdSyncResult, operation: QmdDiagnostic[], release: QmdDiagnostic[]): { sync: QmdSyncResult } {
  return { sync: sync.state === "unavailable" ? unavailable([...sync.textCoverage.diagnostics, ...release], sync.code) : unavailable([...operation, ...release]) };
}

/** Model-free text update in its own session. The entire .wiki/search directory is derived.
 * env: the request environment; direct test callers use the host environment. */
export async function syncQmdText(root: string, inventory: QmdInventory, options: QmdSyncOptions = {}, env: QmdEnvironment = process.env): Promise<QmdSyncResult> {
  return (await inSession(root, options.models, env, async session => ({ sync: await session.sync(inventory, options) }), (o, release) => releasedSync(o.sync, [], release))).sync;
}

/** Lexical oracle for tests and diagnostics: synchronize the full current inventory first. */
export async function searchQmdLex(root: string, query: string, limit = 10): Promise<QmdLexResult> {
  return inSession(root, undefined, process.env, session => session.searchLex(query, limit),
    (lex, release) => ({ state: "unavailable", diagnostics: [...(lex.state === "unavailable" ? lex.diagnostics : []), ...release] }));
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
/** The documented default of the pinned SDK (@tobilu/qmd 2.8.3 SearchOptions.limit: "Max results (default: 10)").
 * find uses it as the final result limit when the caller gives none. */
export const QMD_DEFAULT_LIMIT = 10;
/** Applied to literal and qmd candidates before the final limit. scope: "personal" or "projects/<project>";
 * type: a registered type name, matched against the captured frontmatter type. */
export type QmdFindFilters = { scope?: "personal" | `projects/${string}`; type?: string; limit?: number };
/** lexical: model-free degraded request after a model readiness failure. */
export type QmdFindRequest = QmdFindFilters & (
  | { mode: "fast"; question: string; terms?: string; models: QmdReadyModels<"embed"> }
  | { mode: "deep"; question: string; terms?: string; models: QmdReadyModels<"embed" | "generate" | "rerank"> }
  | { mode: "lexical"; requested: "fast" | "deep"; question: string; terms?: string; reason: QmdDiagnostic[] });
/** Every field comes from one captured revision; digest names those bytes.
 * scope: "personal" or "projects/<project>" from the canonical path; type: the captured frontmatter type.
 * score: the qmd score, or null when only literal matching found the note. literal: the matched path-like tokens. */
export type QmdRenderedMatch = { path: string; scope: string; type: string; score: number | null; literal: string[]; digest: string; title: string; description: string; excerpt: string };
/** Lexical-only results after vector/model failure. Never an exhaustive absence claim. */
export type QmdDegraded = { retrieval: "lexical"; exhaustive: false; reason: "models-unavailable" | "vector-failed" | "expansion-failed"; diagnostics: QmdDiagnostic[] };
export type QmdFindResult =
  | { state: "successful"; mode: "fast" | "deep"; queries: QmdQuery[]; rerank: boolean; degraded?: QmdDegraded; literals: string[]; limit: number; matches: QmdRenderedMatch[];
      /** Omitted candidates: deleted/renamed, stale index, or moving target. Nonempty means text coverage is incomplete. */
      omitted: QmdDiagnostic[];
      /** The queried index does not hold exactly the captured inventory (for example another sync replaced it). Nonempty means text coverage is incomplete. */
      indexMismatch: QmdDiagnostic[] }
  | { state: "unavailable"; code: "conflict" | "unavailable"; diagnostics: QmdDiagnostic[] };

/** Step (c)'s read port over the vault: rereads only vault files, never captured sources. */
function currentNotes(root: string): CurrentNoteReader {
  return { digest(relative) {
    // A missing, refused or non-regular note has no current digest.
    try { return readNoteRevision(root, relative, "note").digest; }
    catch { return undefined; }
  } };
}
/** QMD 2.8.3 swallows expansion grammar/context/prompt failures, returns the unchanged
 * question, then filters it out: an expansion with no usable entry is a failed stage. */
class ExpansionFailedError extends Error {}
function vectorFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  return !(error instanceof IndexWriterBusyError) && !signal?.aborted;
}

/** Find in its own session against an index synchronized earlier (test seam for index mismatch; host environment). */
export async function findQmd(root: string, request: QmdFindRequest, captured: QmdInventory["concepts"], signal?: AbortSignal): Promise<QmdFindResult> {
  return inSession(root, undefined, process.env, session => session.find(request, captured, signal),
    (find, release) => ({ state: "unavailable", code: find.state === "unavailable" ? find.code : "unavailable", diagnostics: [...(find.state === "unavailable" ? find.diagnostics : []), ...release] }));
}
/** One find request: synchronize text and query under one session lock. find is absent when the
 * text update was unavailable (find did not run). */
export async function syncAndFindQmd(root: string, inventory: QmdInventory, options: QmdSyncOptions, request: QmdFindRequest, env: QmdEnvironment, signal?: AbortSignal): Promise<{ sync: QmdSyncResult; find?: QmdFindResult }> {
  return inSession(root, options.models, env, async (session): Promise<{ sync: QmdSyncResult; find?: QmdFindResult }> => {
    const sync = await session.sync(inventory, options);
    return sync.state === "unavailable" ? { sync } : { sync, find: await session.find(request, inventory.concepts, signal) };
  }, (o, release) => releasedSync(o.sync, o.find?.state === "unavailable" ? o.find.diagnostics : [], release));
}

export type QmdEmbedResult =
  | { state: "complete"; embeddingCoverage: { state: "complete" }; embedded: { docsProcessed: number; chunksEmbedded: number; errors: number } }
  | { state: "failed"; code: "conflict" | "unavailable"; embeddingCoverage: QmdEmbeddingCoverage; embedded?: { docsProcessed: number; chunksEmbedded: number; errors: number }; diagnostics: QmdDiagnostic[] };

/** One search sync --embed request: synchronize text and embed under one session lock.
 * embed is absent when the text update was unavailable (embedding did not run). */
export async function syncAndEmbedQmd(root: string, inventory: QmdInventory, options: QmdSyncOptions, models: QmdReadyModels<"embed">, env: QmdEnvironment, signal?: AbortSignal): Promise<{ sync: QmdSyncResult; embed?: QmdEmbedResult }> {
  return inSession(root, options.models, env, async (session): Promise<{ sync: QmdSyncResult; embed?: QmdEmbedResult }> => {
    const sync = await session.sync(inventory, options);
    return sync.state === "unavailable" ? { sync } : { sync, embed: await session.embed(models, signal) };
  }, (o, release) => releasedSync(o.sync, o.embed?.state === "failed" ? o.embed.diagnostics : [], release));
}

// Doctor inspection of a disposable copy. Database file names and QMD 2.8.3 tables stay in this module.
const SEARCH = DIRECTORY;
const DATABASE = SEARCH + "/qmd.sqlite";
/** The index writer lock, relative to the vault root; doctor reports it when retained. */
export const QMD_WRITER_LOCK = DIRECTORY + "/writer.lock";
export type QmdVersionCheck = { state: "ready"; version: string } | { state: "unavailable"; version?: string };
export type QmdInspectInventory = { concepts: readonly { path: string; markdown: string }[]; diagnostics: readonly unknown[] };
export type QmdInspectProblem = (file: string, text: string, fix: string, code?: "unavailable") => void;
export type QmdInspection = {
  qmd: QmdVersionCheck;
  database: { state: "ready" | "unavailable" };
  textCoverage: { state: "complete" | "incomplete" | "unavailable" };
  embeddingCoverage: { state: "complete" | "incomplete"; contentHashes: number } | { state: "unavailable" };
};
function readJson(root: string, relative: string): unknown { return JSON.parse(fs.readFileSync(checked(root, relative), "utf8")); }
// QMD 2.8.3 stores standalone FTS fields with each CJK run spaced by character
// (store.js normalizeCjkForFTS). Compare that representation, not raw Markdown.
function qmdFtsText(text: string): string {
  return text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, run => " " + Array.from(run).join(" ") + " ");
}
/** Throws unless the retained search state shows no active or interrupted writer. */
function assertQuiescentSearch(root: string): void {
  if (fs.existsSync(checked(root, SEARCH + "/writer.lock"))) throw new Error("Index writer lock retained; do not trust previous coverage");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (fs.existsSync(checked(root, DATABASE + suffix))) throw new Error("Retained SQLite sidecar " + DATABASE + suffix + "; index may be active or interrupted. Inspect the writer before explicit recovery");
  }
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** Throws when the diagnostic scratch directory lies inside the vault or HOME/XDG roots. */
function assertIsolatedScratch(root: string, scratch: string): void {
  for (const protectedRoot of [root, process.env.HOME, process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME]) {
    if (!protectedRoot) continue;
    const base = fs.existsSync(protectedRoot) ? fs.realpathSync(protectedRoot) : path.resolve(protectedRoot);
    if (isWithin(base, scratch)) throw new Error("Diagnostic scratch directory must be outside the vault and HOME/XDG; set TMPDIR to an isolated temporary directory");
  }
}

/** Embedding metadata is healthy only when every active chunk has a physical vector row. */
function embeddingVectorsHealthy(db: QMDStore["internal"]["db"], embedded: { hash: string; seq: number }[], problem: QmdInspectProblem): boolean {
  if (!embedded.length) return true;
  try {
    const vectors = new Set(db.prepare("SELECT hash_seq FROM inspected.vectors_vec").all<{ hash_seq: string }>().map(row => row.hash_seq));
    if (embedded.some(row => !vectors.has(row.hash + "_" + row.seq))) throw new Error("Embedding metadata has missing physical vector rows");
    return true;
  } catch (error) {
    problem(DATABASE, "Embedding vector storage is incomplete: " + message(error), "Inspect the interrupted embedding operation and retained local database before explicit search sync --embed; metadata alone does not prove vector coverage");
    return false;
  }
}

/** Doctor's read-only index inspection: takes no writer lock and never opens the retained database
 * with SQLite. Probes the native SDK in memory, then checks a disposable byte copy of the index
 * (SQLite integrity, schema, FTS rows, vector rows, receipts, identities, bodies) against the
 * captured inventory. inventory: undefined unless the profile is compatible and readable.
 * problem receives every diagnostic. Doctor reports a retained writer lock itself; inspection
 * then stops at the quiescence check, so only its own search-state problems decide the summary.
 * env: the request environment; the SDK and the HOME/XDG scratch check read it (withRequestEnvironment). */
export async function inspectQmdIndex(root: string, inventory: QmdInspectInventory | undefined, models: QmdModels, problem: QmdInspectProblem, env: QmdEnvironment): Promise<QmdInspection> {
  return withRequestEnvironment(env, () => inspectInScope(root, inventory, models, problem));
}
async function inspectInScope(root: string, inventory: QmdInspectInventory | undefined, models: QmdModels, problem: QmdInspectProblem): Promise<QmdInspection> {
  let searchProblem = false;
  const report: QmdInspectProblem = (file, ...rest) => { if (file.startsWith(SEARCH)) searchProblem = true; problem(file, ...rest); };
  let qmd: QmdVersionCheck = { state: "unavailable" };
  let database: QmdInspection["database"] = { state: "unavailable" };
  let textCoverage: QmdInspection["textCoverage"] = { state: "unavailable" };
  let embeddingCoverage: QmdInspection["embeddingCoverage"] = { state: "unavailable" };
  let probe: QMDStore | undefined, snapshotStore: QMDStore | undefined;
  let temporary: string | undefined;
  try {
    const entry = import.meta.resolve("@tobilu/qmd");
    const metadata: unknown = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", entry)), "utf8"));
    if (!isMapping(metadata) || typeof metadata.version !== "string") throw new Error("qmd package has no version");
    qmd = { state: "unavailable", version: metadata.version };
    const { createStore } = await import("@tobilu/qmd");
    // Native SQLite/FTS and sqlite-vec probe uses memory only, not the vault store.
    probe = await createStore({ dbPath: ":memory:", config: { collections: {} } });
    probe.internal.db.prepare("SELECT vec_version()").get();
    await probe.searchLex("doctor", { collection: COLLECTION, limit: 1 });
    qmd = { state: "ready", version: metadata.version };
    if (!inventory) throw new Error("Compatible profile and readable concept inventory required");
    assertQuiescentSearch(root);
    // Even a read-only SQLite connection can create WAL/SHM. Capture bytes into
    // a disposable snapshot instead. Never open the retained database with SQLite.
    const bytes = fs.readFileSync(checked(root, DATABASE));
    const scratch = fs.realpathSync(os.tmpdir());
    assertIsolatedScratch(root, scratch);
    temporary = fs.mkdtempSync(path.join(scratch, "wiki-doctor-db-"));
    const copied = path.join(temporary, "qmd.sqlite");
    fs.writeFileSync(copied, bytes, { flag: "wx" });
    probe.internal.db.prepare("ATTACH DATABASE ? AS inspected").run(copied);
    const integrity = probe.internal.db.prepare("PRAGMA inspected.quick_check").all<{ quick_check: string }>();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") throw new Error("SQLite integrity check failed: " + JSON.stringify(integrity));
    if (probe.internal.db.prepare("PRAGMA inspected.foreign_key_check").all().length) throw new Error("SQLite foreign-key check failed");
    // Pin the required 2.8.3 metadata schema before the SDK can migrate its copy.
    const active = activeDocuments(probe.internal.db, "inspected");
    probe.internal.db.prepare("SELECT hash, seq, model, embed_fingerprint, total_chunks FROM inspected.content_vectors").all();
    probe.internal.db.exec("INSERT INTO inspected.documents_fts(documents_fts) VALUES('integrity-check')");
    // Internal FTS integrity permits missing/stale standalone rows. Check the
    // retained set and content before SDK initialization can rebuild its copy.
    const lexical = probe.internal.db.prepare("SELECT rowid, filepath, title, body FROM inspected.documents_fts").all<{ rowid: number; filepath: string; title: string; body: string }>();
    const lexicalById = new Map(lexical.map(row => [row.rowid, row]));
    const lexicalHealthy = lexical.length === active.length && active.every(doc => {
      const row = lexicalById.get(doc.id);
      return row?.filepath === qmdFtsText(doc.collection + "/" + doc.path) && row.title === qmdFtsText(doc.title) && row.body === qmdFtsText(doc.doc);
    });
    if (!lexicalHealthy) report(DATABASE, "Lexical index rows do not equal active document identities and content", "Inspect the retained database and run search sync explicitly; FTS internal integrity and timestamps do not prove text coverage");
    const capturedById = new Map(inventory.concepts.map(concept => [stagedId(concept.path), concept.markdown]));
    const indexedInventoryMatches = active.length === capturedById.size && active.every(doc => doc.collection === COLLECTION && capturedById.get(doc.path) === doc.doc);
    if (!indexedInventoryMatches) report(DATABASE, "Indexed document set/content differs from the captured inventory", "Inspect current notes and run search sync explicitly; no completeness is inferred from timestamps");
    const embedded = probe.internal.db.prepare("SELECT DISTINCT v.hash, v.seq FROM inspected.content_vectors v JOIN inspected.documents d ON d.hash = v.hash WHERE d.active = 1").all<{ hash: string; seq: number }>();
    const vectorsHealthy = embeddingVectorsHealthy(probe.internal.db, embedded, report);
    probe.internal.db.exec("DETACH DATABASE inspected");
    snapshotStore = await createStore({ dbPath: copied, config: { collections: {}, models: models } });
    const status = await snapshotStore.getStatus();
    database = { state: lexicalHealthy && vectorsHealthy ? "ready" : "unavailable" };
    const expected = inventory.concepts.map(c => ({ path: c.path, digest: digest(c.markdown) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    let complete = lexicalHealthy && indexedInventoryMatches && inventory.diagnostics.length === 0 && status.totalDocuments === expected.length;
    const receipt = readJson(root, SEARCH + "/coverage.json");
    if (!isMapping(receipt) || receipt.version !== 1 || JSON.stringify(receipt.inventory) !== JSON.stringify(expected)) {
      complete = false;
      report(SEARCH + "/coverage.json", "Successful coverage receipt does not match captured path/content digests", "Run search sync explicitly after inspecting earlier failures");
    }
    const identities = readJson(root, SEARCH + "/identities.json");
    const expectedIdentities = inventory.concepts.map(c => ({ id: stagedId(c.path), path: c.path }));
    const identityFormat = isMapping(identities) && identities.version === 1 && Array.isArray(identities.paths);
    const actualIdentities: unknown[] = isMapping(identities) && Array.isArray(identities.paths) ? identities.paths : [];
    if (!identityFormat || actualIdentities.length !== expectedIdentities.length || expectedIdentities.some(expected => !actualIdentities.some(row => isMapping(row) && row.id === expected.id && row.path === expected.path))) {
      complete = false; report(SEARCH + "/identities.json", "Missing or incompatible canonical identity mapping", "Inspect retained search state, then run search sync explicitly");
    }
    const bodies = indexedBodies(snapshotStore);
    for (const concept of inventory.concepts) {
      if ((bodies.get(stagedId(concept.path)) ?? null) !== concept.markdown) {
        complete = false; report(concept.path, "Indexed text differs from captured note bytes", "Run search sync explicitly; timestamps do not establish coverage");
      }
    }
    if (!bytes.equals(fs.readFileSync(checked(root, DATABASE))) || ["/writer.lock", "/qmd.sqlite-wal", "/qmd.sqlite-shm", "/qmd.sqlite-journal"].some(suffix => fs.existsSync(checked(root, SEARCH + suffix)))) throw new Error("Search database changed during inspection");
    textCoverage = { state: complete ? "complete" : "incomplete" };
    if (!complete && !searchProblem) report(SEARCH, "Text index does not cover the complete captured inventory", "Inspect diagnostics and run search sync explicitly");
    embeddingCoverage = vectorsHealthy && models.embed ? { state: complete && status.needsEmbedding === 0 ? "complete" : "incomplete", contentHashes: status.needsEmbedding } : { state: "unavailable" };
  } catch (error) {
    report(qmd.state === "ready" ? DATABASE : "@tobilu/qmd (native SQLite/sqlite-vec)", message(error), qmd.state === "ready" ? "Inspect retained local database, receipts and locks before explicit search sync; doctor never repairs them" : "Supply the pinned qmd SDK and compatible native dependencies for this Node runtime; doctor does not install them", "unavailable");
    textCoverage = { state: "unavailable" }; embeddingCoverage = { state: "unavailable" };
  } finally {
    for (const store of [snapshotStore, probe]) {
      try { await store?.close(); } catch (error) { report(DATABASE, "Diagnostic database close failed: " + message(error), "Inspect runtime/native dependency health", "unavailable"); database = { state: "unavailable" }; textCoverage = { state: "unavailable" }; embeddingCoverage = { state: "unavailable" }; }
    }
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { report(temporary, "Diagnostic snapshot cleanup failed: " + message(error), "Inspect and explicitly remove this disposable diagnostic snapshot; the vault was not repaired", "unavailable"); }
    }
  }
  return { qmd, database, textCoverage, embeddingCoverage };
}
