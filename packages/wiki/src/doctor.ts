import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { QMDStore } from "@tobilu/qmd";
import { inspectContainedPath } from "./paths.ts";
import { inspectVault } from "./lint.ts";
import { isMapping } from "./frontmatter.ts";
import { indexFreshnessDiagnostics } from "./navigation.ts";
import type { ErrorCode } from "./vault.ts";
import { qmdModelReadiness, DEEP_ROLES, type QmdModels, type QmdModelRole } from "./qmd.ts";

type Problem = { path: string; message: string; fix: string };
type Check = { state: "ready" } | { state: "unavailable" };
type VersionCheck = { state: "ready"; version: string } | { state: "unavailable"; version?: string };
type Coverage = { state: "complete" | "incomplete" | "unavailable" };
type EmbeddingCoverage = { state: "complete" | "incomplete"; contentHashes: number } | { state: "unavailable" };
const SEARCH = ".wiki/search";
const DATABASE = SEARCH + "/qmd.sqlite";
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function digest(bytes: string | Buffer): string { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
// QMD 2.8.3 stores standalone FTS fields with each CJK run spaced by character
// (store.js normalizeCjkForFTS). Compare that representation, not raw Markdown.
function qmdFtsText(text: string): string {
  return text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, run => " " + Array.from(run).join(" ") + " ");
}
function checked(root: string, relative: string): string {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new Error(inspected.problem.message);
  return inspected.full;
}
function readJson(root: string, relative: string): unknown { return JSON.parse(fs.readFileSync(checked(root, relative), "utf8")); }

/** Delegate all file/configuration validation to search's model-free preflight.
 * Request each role separately so a missing deep-only model does not hide embed readiness. */
function doctorModelReadiness(root: string, problems: Problem[]) {
  const models: QmdModels = {};
  const checks: Record<QmdModelRole, Check> = { embed: { state: "unavailable" }, generate: { state: "unavailable" }, rerank: { state: "unavailable" } };
  const diagnostics = new Map<string, Problem>();
  for (const role of DEEP_ROLES) {
    const readiness = qmdModelReadiness(root, [role]);
    if (readiness.state === "ready") {
      models[role] = readiness.models[role]; checks[role] = { state: "ready" };
    } else {
      for (const diagnostic of readiness.diagnostics) diagnostics.set(diagnostic.path + "\n" + diagnostic.message, {
        ...diagnostic, fix: "Configure an existing readable absolute local GGUF file in search.models. File readiness does not prove inference compatibility; doctor never resolves or downloads models",
      });
    }
  }
  problems.push(...diagnostics.values());
  return { models, checks };
}

function extractor(command: "pandoc" | "pdftotext", problems: Problem[]): VersionCheck {
  const result = spawnSync(command, command === "pandoc" ? ["--version"] : ["-v"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
  const output = result.stdout + "\n" + result.stderr;
  const version = (command === "pandoc" ? /^pandoc\s+(\S+)/m : /pdftotext version\s+(\S+)/).exec(output)?.[1];
  if (!result.error && result.status === 0 && version) return { state: "ready", version };
  problems.push({ path: command, message: command + " unavailable: " + (result.error?.message ?? "No successful version response"), fix: "Supply a working " + command + " on PATH; doctor does not install or run extraction" });
  return { state: "unavailable" };
}

/** Inspect only. No writer lock, synchronization, note publication, or SDK model resolution. */
export async function doctorVault(selected: string) {
  const root = path.resolve(selected), diagnostics: Problem[] = [];
  let failure: ErrorCode | undefined;
  const problem = (file: string, text: string, fix: string, code: ErrorCode = "damaged") => {
    diagnostics.push({ path: file, message: text, fix }); failure ??= code;
  };
  const rootEntry = inspectContainedPath(root, "");
  if (!rootEntry.ok) problem(root, rootEntry.problem.message, "Select a regular explicit vault directory", "usage");
  else if (!rootEntry.stat) problem(root, "Missing requested vault", "Select an existing profile vault; doctor does not initialize directories", "not_found");
  else if (!rootEntry.stat.isDirectory()) problem(root, "Vault is not a directory", "Select a regular explicit vault directory", "usage");
  let profile: Check = { state: "unavailable" };
  try {
    const config = readJson(root, ".wiki/config.json");
    if (!isMapping(config) || !("profile" in config) || !("version" in config)) throw new Error("Configuration requires profile and version");
    if (config.profile !== "wiki-okf" || config.version !== 1) problem(".wiki/config.json", "Unsupported profile/version; expected wiki-okf version 1", "Select a compatible explicit vault; no conversion or reinitialization performed", "unsupported");
    else profile = { state: "ready" };
  } catch (error) { problem(".wiki/config.json", message(error), "Inspect retained configuration and restore valid wiki-okf version 1 JSON explicitly; do not reinitialize over retained files"); }
  const layoutStart = diagnostics.length;
  for (const [relative, kind] of [["", "directory"], [".wiki", "directory"], [".wiki/config.json", "file"], [".wiki/types", "directory"], [".wiki/tmp", "directory"], [".wiki/locks", "directory"], ["index.md", "file"], ["log.md", "file"], [".gitignore", "file"]] as const) {
    try {
      const item = inspectContainedPath(root, relative);
      if (!item.ok) throw new Error(item.problem.message);
      if (!item.stat || (kind === "directory" ? !item.stat.isDirectory() : !item.stat.isFile())) throw new Error("Missing or not a " + kind);
    } catch (error) { problem(relative, message(error), "Inspect incomplete layout and retained files before explicit repair; doctor changes nothing"); }
  }
  const layout: Check = { state: diagnostics.length === layoutStart ? "ready" : "unavailable" };
  let inventory: ReturnType<typeof inspectVault> | undefined;
  let registry: Check = { state: "unavailable" };
  if (profile.state === "ready") {
    try {
      const directory = inspectContainedPath(root, ".wiki/types");
      if (!directory.ok) throw new Error(directory.problem.message);
      if (!directory.stat?.isDirectory() || !fs.readdirSync(directory.full).some(name => name.endsWith(".json"))) throw new Error("Missing registry records in .wiki/types");
      inventory = inspectVault(root);
      const issues = inventory.diagnostics;
      registry = { state: issues.some(d => d.rule.startsWith("registry.")) ? "unavailable" : "ready" };
      for (const d of issues) problem(d.path, d.rule + ": " + d.message, d.fix);
    } catch (error) { problem(".wiki/types", message(error), "Restore readable compatible registry records and files; no scaffolds are installed"); }
  }
  const navigationProblems: ReturnType<typeof indexFreshnessDiagnostics> = [];
  if (inventory && inventory.diagnostics.length === 0) {
    for (const [relative, bytes] of inventory.indexes) {
      try { navigationProblems.push(...indexFreshnessDiagnostics(root, new Map([[relative, bytes]]))); }
      catch (error) {
        navigationProblems.push({ path: relative, rule: "index.unreadable", message: message(error), fix: "Restore readable regular generated-index files, then run index explicitly if needed; doctor does not regenerate navigation" });
      }
    }
  }
  for (const d of navigationProblems) problem(d.path, d.rule + ": " + d.message, d.fix);
  const navigation: Check = { state: inventory && !inventory.diagnostics.length && !navigationProblems.length ? "ready" : "unavailable" };
  for (const relative of [".wiki/locks/mutation.lock", SEARCH + "/writer.lock"]) {
    try { if (fs.lstatSync(checked(root, relative))) problem(relative, "Retained writer lock; inspection cannot certify a stable inventory", "Inspect ownership and verify no cooperating owner is active before explicit removal; never remove based on age", "conflict"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) problem(relative, message(error), "Inspect retained lock without reclaiming it"); }
  }
  try {
    const temporary = fs.readdirSync(checked(root, ".wiki/tmp"));
    for (const name of temporary.sort()) problem(".wiki/tmp/" + name, "Retained temporary entry; a previous operation may be partial", "Inspect retained bytes, published paths, log.md and generated indexes before explicit cleanup; do not blindly retry publication");
  } catch (error) { problem(".wiki/tmp", message(error), "Inspect retained temporary state manually"); }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const node: VersionCheck = major > 22 || major === 22 && minor >= 18 ? { state: "ready", version: process.versions.node } : { state: "unavailable", version: process.versions.node };
  if (node.state === "unavailable") problem("node", "Node >=22.18 is required; actual " + process.versions.node, "Run the source CLI under a supported Node runtime", "unavailable");
  const extractors = { pandoc: extractor("pandoc", diagnostics), pdftotext: extractor("pdftotext", diagnostics) };
  const modelReadiness = doctorModelReadiness(root, diagnostics);
  let qmd: VersionCheck = { state: "unavailable" };
  let database: Check = { state: "unavailable" };
  let textCoverage: Coverage = { state: "unavailable" };
  let embeddingCoverage: EmbeddingCoverage = { state: "unavailable" };
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
    await probe.searchLex("doctor", { collection: "concepts", limit: 1 });
    qmd = { state: "ready", version: metadata.version };
    if (profile.state !== "ready" || !inventory) throw new Error("Compatible profile and readable concept inventory required");
    if (fs.existsSync(checked(root, SEARCH + "/writer.lock"))) throw new Error("Index writer lock retained; do not trust previous coverage");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs.existsSync(checked(root, DATABASE + suffix))) throw new Error("Retained SQLite sidecar " + DATABASE + suffix + "; index may be active or interrupted. Inspect the writer before explicit recovery");
    }
    // Even a read-only SQLite connection can create WAL/SHM. Capture bytes into
    // a disposable snapshot instead. Never open the retained database with SQLite.
    const bytes = fs.readFileSync(checked(root, DATABASE));
    const scratch = fs.realpathSync(os.tmpdir());
    for (const protectedRoot of [root, process.env.HOME, process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME]) {
      if (!protectedRoot) continue;
      const base = fs.existsSync(protectedRoot) ? fs.realpathSync(protectedRoot) : path.resolve(protectedRoot);
      const relative = path.relative(base, scratch);
      if (!relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw new Error("Diagnostic scratch directory must be outside the vault and HOME/XDG; set TMPDIR to an isolated temporary directory");
    }
    temporary = fs.mkdtempSync(path.join(scratch, "wiki-doctor-db-"));
    const copied = path.join(temporary, "qmd.sqlite");
    fs.writeFileSync(copied, bytes, { flag: "wx" });
    probe.internal.db.prepare("ATTACH DATABASE ? AS inspected").run(copied);
    const integrity = probe.internal.db.prepare("PRAGMA inspected.quick_check").all<{ quick_check: string }>();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") throw new Error("SQLite integrity check failed: " + JSON.stringify(integrity));
    if (probe.internal.db.prepare("PRAGMA inspected.foreign_key_check").all().length) throw new Error("SQLite foreign-key check failed");
    // Pin the required 2.8.3 metadata schema before the SDK can migrate its copy.
    const active = probe.internal.db.prepare("SELECT d.id, d.collection, d.path, d.title, c.doc FROM inspected.documents d JOIN inspected.content c ON c.hash = d.hash WHERE d.active = 1").all<{ id: number; collection: string; path: string; title: string; doc: string }>();
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
    if (!lexicalHealthy) problem(DATABASE, "Lexical index rows do not equal active document identities and content", "Inspect the retained database and run search sync explicitly; FTS internal integrity and timestamps do not prove text coverage");
    const capturedById = new Map(inventory.concepts.map(concept => [createHash("sha256").update(concept.path).digest("hex") + ".md", concept.markdown]));
    const indexedInventoryMatches = active.length === capturedById.size && active.every(doc => doc.collection === "concepts" && capturedById.get(doc.path) === doc.doc);
    if (!indexedInventoryMatches) problem(DATABASE, "Indexed document set/content differs from the captured inventory", "Inspect current notes and run search sync explicitly; no completeness is inferred from timestamps");
    const embedded = probe.internal.db.prepare("SELECT DISTINCT v.hash, v.seq FROM inspected.content_vectors v JOIN inspected.documents d ON d.hash = v.hash WHERE d.active = 1").all<{ hash: string; seq: number }>();
    let vectorsHealthy = true;
    if (embedded.length) {
      try {
        const vectors = new Set(probe.internal.db.prepare("SELECT hash_seq FROM inspected.vectors_vec").all<{ hash_seq: string }>().map(row => row.hash_seq));
        if (embedded.some(row => !vectors.has(row.hash + "_" + row.seq))) throw new Error("Embedding metadata has missing physical vector rows");
      } catch (error) {
        vectorsHealthy = false;
        problem(DATABASE, "Embedding vector storage is incomplete: " + message(error), "Inspect the interrupted embedding operation and retained local database before explicit search sync --embed; metadata alone does not prove vector coverage");
      }
    }
    probe.internal.db.exec("DETACH DATABASE inspected");
    snapshotStore = await createStore({ dbPath: copied, config: { collections: {}, models: modelReadiness.models } });
    const status = await snapshotStore.getStatus();
    database = { state: lexicalHealthy && vectorsHealthy ? "ready" : "unavailable" };
    const expected = inventory.concepts.map(c => ({ path: c.path, digest: digest(c.markdown) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    let complete = lexicalHealthy && indexedInventoryMatches && inventory.diagnostics.length === 0 && status.totalDocuments === expected.length;
    const receipt = readJson(root, SEARCH + "/coverage.json");
    if (!isMapping(receipt) || receipt.version !== 1 || JSON.stringify(receipt.inventory) !== JSON.stringify(expected)) {
      complete = false;
      problem(SEARCH + "/coverage.json", "Successful coverage receipt does not match captured path/content digests", "Run search sync explicitly after inspecting earlier failures");
    }
    const identities = readJson(root, SEARCH + "/identities.json");
    const expectedIdentities = inventory.concepts.map(c => ({ id: createHash("sha256").update(c.path).digest("hex") + ".md", path: c.path }));
    const identityFormat = isMapping(identities) && identities.version === 1 && Array.isArray(identities.paths);
    const actualIdentities: unknown[] = isMapping(identities) && Array.isArray(identities.paths) ? identities.paths : [];
    if (!identityFormat || actualIdentities.length !== expectedIdentities.length || expectedIdentities.some(expected => !actualIdentities.some(row => isMapping(row) && row.id === expected.id && row.path === expected.path))) {
      complete = false; problem(SEARCH + "/identities.json", "Missing or incompatible canonical identity mapping", "Inspect retained search state, then run search sync explicitly");
    }
    for (const concept of inventory.concepts) {
      const id = createHash("sha256").update(concept.path).digest("hex") + ".md";
      if (await snapshotStore.getDocumentBody("qmd://concepts/" + id) !== concept.markdown) {
        complete = false; problem(concept.path, "Indexed text differs from captured note bytes", "Run search sync explicitly; timestamps do not establish coverage");
      }
    }
    if (!bytes.equals(fs.readFileSync(checked(root, DATABASE))) || ["/writer.lock", "/qmd.sqlite-wal", "/qmd.sqlite-shm", "/qmd.sqlite-journal"].some(suffix => fs.existsSync(checked(root, SEARCH + suffix)))) throw new Error("Search database changed during inspection");
    textCoverage = { state: complete ? "complete" : "incomplete" };
    if (!complete && !diagnostics.some(d => d.path.startsWith(SEARCH))) problem(SEARCH, "Text index does not cover the complete captured inventory", "Inspect diagnostics and run search sync explicitly");
    embeddingCoverage = vectorsHealthy && modelReadiness.models.embed ? { state: complete && status.needsEmbedding === 0 ? "complete" : "incomplete", contentHashes: status.needsEmbedding } : { state: "unavailable" };
  } catch (error) {
    problem(qmd.state === "ready" ? DATABASE : "@tobilu/qmd (native SQLite/sqlite-vec)", message(error), qmd.state === "ready" ? "Inspect retained local database, receipts and locks before explicit search sync; doctor never repairs them" : "Supply the pinned qmd SDK and compatible native dependencies for this Node runtime; doctor does not install them", "unavailable");
    textCoverage = { state: "unavailable" }; embeddingCoverage = { state: "unavailable" };
  } finally {
    for (const store of [snapshotStore, probe]) {
      try { await store?.close(); } catch (error) { problem(DATABASE, "Diagnostic database close failed: " + message(error), "Inspect runtime/native dependency health", "unavailable"); database = { state: "unavailable" }; textCoverage = { state: "unavailable" }; embeddingCoverage = { state: "unavailable" }; }
    }
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); }
      catch (error) { problem(temporary, "Diagnostic snapshot cleanup failed: " + message(error), "Inspect and explicitly remove this disposable diagnostic snapshot; the vault was not repaired", "unavailable"); }
    }
  }
  if (diagnostics.length) failure ??= "unavailable";
  return {
    ok: failure === undefined,
    ...(failure ? { error: { code: failure, message: "Foundation readiness has diagnostics; no repairs performed" } } : {}),
    root, profile, layout, registry, navigation, runtime: { node, qmd }, extractors, models: modelReadiness.checks,
    search: { database, textCoverage, embeddingCoverage },
    coverageBasis: "captured-inventory; no timestamp freshness guarantee", sourceCorrectness: "not-asserted", diagnostics,
  };
}

export function doctorText(report: Awaited<ReturnType<typeof doctorVault>>): string {
  const version = (check: VersionCheck) => check.state + (check.version ? " (" + check.version + ")" : "");
  return "Foundation inspection: " + (report.ok ? "completed" : "diagnostics") + " (read-only)\n" +
    "Node: " + version(report.runtime.node) + "\nqmd/native: " + version(report.runtime.qmd) + "\n" +
    Object.entries(report.extractors).map(([name, check]) => name + ": " + version(check) + "\n").join("") +
    "Profile: " + report.profile.state + "; layout: " + report.layout.state + "; registry: " + report.registry.state + "; navigation: " + report.navigation.state + "\n" +
    "Local database: " + report.search.database.state + "\nText coverage: " + report.search.textCoverage.state + "\nEmbedding coverage: " + report.search.embeddingCoverage.state + "\n" +
    "Coverage: captured inventory only, not timestamp freshness or source correctness. No repairs performed.\n" +
    report.diagnostics.map(d => d.path + ": " + d.message + "; fix: " + d.fix + "\n").join("");
}
