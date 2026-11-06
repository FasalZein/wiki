import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { QMDStore, UpdateProgress, UpdateResult } from "@tobilu/qmd";
import { canonicalPathProblem, inspectContainedPath } from "./paths.ts";

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
  | { state: "unavailable"; textCoverage: Extract<QmdTextCoverage, { state: "unavailable" }>; embeddingCoverage: { state: "unavailable" } };
export type QmdSyncOptions = { signal?: AbortSignal; onProgress?: (progress: UpdateProgress) => void };
export type QmdLexResult =
  | { state: "successful"; matches: { path: string; markdown: string; score: number }[] }
  | { state: "unavailable"; diagnostics: QmdDiagnostic[] };

const DIRECTORY = ".wiki/search";
const COLLECTION = "concepts";
const PREFIX = "qmd://" + COLLECTION + "/";
function digest(markdown: string): string { return "sha256:" + createHash("sha256").update(markdown).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function checked(root: string, relative: string): string {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new Error(inspected.problem.message);
  return inspected.full;
}
function acquire(root: string) {
  const directory = checked(root, DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  const lock = checked(root, DIRECTORY + "/writer.lock");
  // Separate from the content mutation lock. Never guess whether another writer is stale.
  const fd = fs.openSync(lock, "wx");
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
async function open(root: string): Promise<QMDStore> {
  const dbPath = checked(root, DIRECTORY + "/qmd.sqlite");
  for (const suffix of ["-wal", "-shm", "-journal"]) checked(root, DIRECTORY + "/qmd.sqlite" + suffix);
  // Lazy import keeps ordinary vault commands independent of native search dependencies.
  const { createStore } = await import("@tobilu/qmd");
  return createStore({ dbPath, config: { collections: { [COLLECTION]: {
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
  let release: (() => void) | undefined;
  let store: QMDStore | undefined;
  try {
    release = acquire(root);
    const manifest = checked(root, DIRECTORY + "/coverage.json");
    fs.rmSync(manifest, { force: true });
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
    for (const [relative, markdown] of concepts) {
      const full = checked(root, DIRECTORY + "/snapshots/" + relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, markdown, { flag: "wx" });
    }
    store = await open(root);
    const update = await store.update({ collections: [COLLECTION], onProgress(progress) {
      options.signal?.throwIfAborted();
      options.onProgress?.(progress);
      options.signal?.throwIfAborted();
    } });
    options.signal?.throwIfAborted();
    if (update.skipped) throw new Error("QMD skipped " + update.skipped + " captured concepts");
    const indexed: QmdDigest[] = [];
    for (const [relative, markdown] of concepts) {
      options.signal?.throwIfAborted();
      const body = await store.getDocumentBody(PREFIX + relative);
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
    if (diagnostics.length) return { state: "incomplete", textCoverage: { state: "incomplete", diagnostics }, embeddingCoverage, update };
    indexed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    options.signal?.throwIfAborted();
    // No receipt survives a failed/interrupted update. Publish only after body comparison.
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, inventory: indexed }) + "\n", { flag: "wx" });
    return { state: "successful", textCoverage: { state: "complete", inventory: indexed }, embeddingCoverage, update };
  } catch (error) {
    return { state: "unavailable", textCoverage: { state: "unavailable", diagnostics: [{ path: DIRECTORY, message: message(error) }] }, embeddingCoverage: { state: "unavailable" } };
  } finally {
    try { await store?.close(); } finally { release?.(); }
  }
}

/** Lexical operation only, not a freshness/coverage claim. Synchronize the full
 * current inventory first. This interface cannot start models or embeddings. */
export async function searchQmdLex(root: string, query: string, limit = 10): Promise<QmdLexResult> {
  let release: (() => void) | undefined;
  let store: QMDStore | undefined;
  try {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Expected a positive integer lexical limit");
    release = acquire(root);
    const dbPath = checked(root, DIRECTORY + "/qmd.sqlite");
    if (!fs.existsSync(dbPath)) throw new Error("Text index unavailable; synchronize captured concepts first");
    store = await open(root);
    const results = await store.searchLex(query, { collection: COLLECTION, limit });
    const matches = [];
    for (const result of results) {
      if (!result.filepath.startsWith(PREFIX)) throw new Error("Unexpected indexed collection identity");
      const relative = result.filepath.slice(PREFIX.length);
      if (conceptProblem(relative)) throw new Error("Unexpected indexed concept path: " + relative);
      const markdown = await store.getDocumentBody(result.filepath);
      if (markdown === null) throw new Error("Missing indexed result body: " + relative);
      matches.push({ path: relative, markdown, score: result.score });
    }
    return { state: "successful", matches };
  } catch (error) {
    return { state: "unavailable", diagnostics: [{ path: DIRECTORY, message: message(error) }] };
  } finally {
    try { await store?.close(); } finally { release?.(); }
  }
}
