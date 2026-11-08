import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const GUARD = fileURLToPath(new URL("./doctor-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-doctor-"));
const home = path.join(temp, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, "sentinel"), "Do not touch");
const env = { ...process.env, HOME: home, XDG_CACHE_HOME: path.join(home, "cache"), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), WIKI_VAULT: "" };
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function cli(vault: string, args: string[], overrides = {}, json = true) {
  const result = spawnSync(process.execPath, [...(args[0] === "doctor" ? ["--import", GUARD] : []), BIN, "--vault", vault, ...(json ? ["--json"] : []), ...args], { env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null, result.stderr);
  if (json) assert.equal(result.stderr, "");
  return { status: result.status, data: json ? JSON.parse(result.stdout) : undefined, stdout: result.stdout, stderr: result.stderr };
}
function succeeds(vault: string, args: string[]) { const result = cli(vault, args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data; }
function fresh() { const vault = path.join(temp, String(++counter)); succeeds(vault, ["init"]); return vault; }
function note(vault: string) { return succeeds(vault, ["new", "note", "--personal", "--title", "Telescope", "--description", "Violet photon"]).path as string; }
// Byte digests, entry kinds and every directory name, including dotfiles. No timestamp proxy.
function snapshot(root: string): object {
  const result: Record<string, string> = {};
  function visit(relative: string) {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) result[relative] = "link:" + fs.readlinkSync(full);
    else if (stat.isDirectory()) { result[relative] = "directory"; for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name)); }
    else result[relative] = "sha256:" + createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
  visit(""); return result;
}
function doctor(vault: string, overrides = {}, json = true) {
  const before = snapshot(vault), beforeHome = snapshot(home);
  const result = cli(vault, ["doctor"], overrides, json);
  assert.deepEqual(snapshot(vault), before, "Doctor must preserve vault bytes and all names");
  assert.deepEqual(snapshot(home), beforeHome, "Doctor must preserve decoy HOME/XDG bytes and all names");
  return result;
}

test("okf:17 real CLI reports actual versions, profile, layout and separate read-only coverage", () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault);
  assert.equal(result.status, 7); // Models are deliberately not provisioned by init or doctor.
  assert.equal(result.data.runtime.node.version, process.versions.node);
  assert.equal(result.data.runtime.qmd.version, "2.8.3");
  assert.equal(result.data.runtime.qmd.state, "ready");
  for (const [name, args, expression] of [["pandoc", ["--version"], /^pandoc\s+(\S+)/m], ["pdftotext", ["-v"], /pdftotext version\s+(\S+)/]] as const) {
    const actual = spawnSync(name, [...args], { encoding: "utf8", env, timeout: 5000 });
    assert.equal(actual.status, 0);
    assert.equal(result.data.extractors[name].version, expression.exec(actual.stdout + "\n" + actual.stderr)?.[1]);
  }
  assert.equal(result.data.profile.state, "ready"); assert.equal(result.data.layout.state, "ready"); assert.equal(result.data.registry.state, "ready");
  assert.equal(result.data.search.database.state, "ready");
  assert.equal(result.data.search.textCoverage.state, "complete");
  assert.equal(result.data.search.embeddingCoverage.state, "unavailable");
  assert.match(JSON.stringify(result.data.diagnostics), /search.models.embed/);
  assert.match(result.data.coverageBasis, /captured-inventory/);
  assert.equal(result.data.sourceCorrectness, "not-asserted");
});

function configureModels(vault: string) {
  // This fixture tests file preflight only. Inference is forbidden by the child guard.
  const local = path.join(vault, "models"); fs.mkdirSync(local);
  const models = Object.fromEntries(["embed", "generate", "rerank"].map(role => {
    const file = path.join(local, role + ".gguf"); fs.writeFileSync(file, "GGUF file-preflight fixture, not an inference model"); return [role, file];
  }));
  fs.writeFileSync(path.join(vault, ".wiki/config.json"), JSON.stringify({ profile: "wiki-okf", version: 1, search: { models } }));
}

test("okf:17 configured model-file readiness never resolves models, and pending embeddings remain separate from complete text", () => {
  const vault = fresh(); configureModels(vault); succeeds(vault, ["search", "sync"]);
  const empty = doctor(vault); assert.equal(empty.status, 0, JSON.stringify(empty.data));
  assert.equal(empty.data.search.textCoverage.state, "complete"); assert.equal(empty.data.search.embeddingCoverage.state, "complete");
  note(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault); assert.equal(result.status, 0, JSON.stringify(result.data));
  assert.deepEqual(result.data.models, { embed: { state: "ready" }, generate: { state: "ready" }, rerank: { state: "ready" } });
  assert.equal(result.data.search.textCoverage.state, "complete");
  assert.deepEqual(result.data.search.embeddingCoverage, { state: "incomplete", contentHashes: 1 });
  const human = doctor(vault, {}, false); assert.equal(human.status, 0); assert.equal(human.stderr, "");
  for (const expression of [/Node: ready \(/, /qmd\/native: ready \(/, /pandoc: ready \(/, /pdftotext: ready \(/, /Profile: ready/, /Text coverage: complete/, /Embedding coverage: incomplete/, /not timestamp freshness or source correctness/, /No repairs performed/]) assert.match(human.stdout, expression);
});

for (const change of ["equal-time-edit", "add", "rename", "delete"]) test("okf:17 captured content detects " + change + " without sync or receipt rewrites", () => {
  const vault = fresh(), relative = note(vault), file = path.join(vault, relative);
  configureModels(vault); succeeds(vault, ["search", "sync"]);
  const before = fs.statSync(file);
  if (change === "equal-time-edit") { const bytes = fs.readFileSync(file, "utf8"); fs.writeFileSync(file, bytes.replace("Violet", "Yellow")); fs.utimesSync(file, before.atime, before.mtime); }
  if (change === "add") fs.copyFileSync(file, path.join(vault, "personal/notes/extra.md"));
  if (change === "rename") fs.renameSync(file, path.join(vault, "personal/notes/renamed.md"));
  if (change === "delete") fs.unlinkSync(file);
  const result = doctor(vault); assert.equal(result.status, 6, JSON.stringify(result.data));
  assert.equal(result.data.search.database.state, "ready"); assert.equal(result.data.search.textCoverage.state, "incomplete");
  assert.notEqual(result.data.search.embeddingCoverage.state, "complete");
  assert.match(JSON.stringify(result.data.diagnostics), /captured|Indexed text/);
});

test("okf:17 unreadable concepts are named, never silently omitted from text coverage", () => {
  const vault = fresh(); const relative = note(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault, { OKF_DOCTOR_GUARD: "unreadable" });
  assert.equal(result.status, 6); assert.equal(result.data.search.textCoverage.state, "incomplete");
  assert.ok(result.data.diagnostics.some((d: { path: string; message: string }) => d.path === relative && /unreadable/.test(d.message)));
});

test("okf:17 missing extractors name Pandoc and pdftotext without installation or fallback", () => {
  const vault = fresh(); configureModels(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault, { PATH: "" }); assert.equal(result.status, 7);
  assert.equal(result.data.extractors.pandoc.state, "unavailable"); assert.equal(result.data.extractors.pdftotext.state, "unavailable");
  assert.equal(result.data.search.textCoverage.state, "complete");
  for (const dependency of ["pandoc", "pdftotext"]) assert.ok(result.data.diagnostics.some((d: { path: string; fix: string }) => d.path === dependency && /PATH/.test(d.fix)));
});
for (const mode of ["missing-sdk", "missing-native", "missing-vector"]) test("okf:17 " + mode + " reports qmd dependency without writable store or global changes", () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault, { OKF_DOCTOR_GUARD: mode }); assert.equal(result.status, 7);
  assert.equal(result.data.runtime.qmd.state, "unavailable"); assert.equal(result.data.search.textCoverage.state, "unavailable");
  assert.match(JSON.stringify(result.data.diagnostics), /qmd.*native SQLite\/sqlite-vec/);
});

for (const model of ["missing", "remote", "unreadable-format", "malformed-search"]) test("okf:17 configured " + model + " model dependency is actionable and never downloaded", () => {
  const vault = fresh(); configureModels(vault); note(vault); succeeds(vault, ["search", "sync"]);
  const configFile = path.join(vault, ".wiki/config.json"), config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (model === "missing") fs.unlinkSync(config.search.models.embed);
  if (model === "remote") config.search.models.embed = "https://example.invalid/model.gguf";
  if (model === "unreadable-format") fs.writeFileSync(config.search.models.embed, "not a GGUF");
  if (model === "malformed-search") config.search = [];
  fs.writeFileSync(configFile, JSON.stringify(config));
  const result = doctor(vault); assert.equal(result.status, 7, JSON.stringify(result.data));
  assert.equal(result.data.models.embed.state, "unavailable"); assert.equal(result.data.search.embeddingCoverage.state, "unavailable");
  assert.equal(result.data.search.textCoverage.state, "complete");
  assert.match(JSON.stringify(result.data.diagnostics), /search.models/);
});

for (const damage of ["config-json", "config-missing", "config-unsupported", "registry-json", "registry-missing", "layout-missing"]) test("okf:17 " + damage + " reports retained damage without reinitializing", () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  if (damage === "config-json") fs.writeFileSync(path.join(vault, ".wiki/config.json"), "{broken");
  if (damage === "config-missing") fs.unlinkSync(path.join(vault, ".wiki/config.json"));
  if (damage === "config-unsupported") fs.writeFileSync(path.join(vault, ".wiki/config.json"), '{"profile":"foreign","version":2}');
  if (damage === "registry-json") fs.writeFileSync(path.join(vault, ".wiki/types/note.json"), "{broken");
  if (damage === "registry-missing") fs.rmSync(path.join(vault, ".wiki/types"), { recursive: true });
  if (damage === "layout-missing") fs.unlinkSync(path.join(vault, "log.md"));
  const result = doctor(vault); assert.equal(result.status, damage === "config-unsupported" ? 5 : 6, JSON.stringify(result.data));
  assert.equal(result.data.ok, false);
  if (damage === "layout-missing") { assert.equal(result.data.layout.state, "unavailable"); assert.equal(result.data.search.textCoverage.state, "complete"); }
  else assert.notEqual(result.data.search.textCoverage.state, "complete");
  assert.ok(result.data.diagnostics.every((d: { fix: string }) => d.fix.length > 0));
});

test("okf:17 foreign vault remains foreign and is not silently initialized", () => {
  const vault = path.join(temp, String(++counter)); fs.mkdirSync(vault); fs.writeFileSync(path.join(vault, "foreign.md"), "Owner bytes");
  const result = doctor(vault); assert.equal(result.status, 6); assert.equal(result.data.profile.state, "unavailable");
  assert.equal(fs.existsSync(path.join(vault, ".wiki")), false);
});

for (const damage of ["database-corrupt", "database-missing", "receipt-missing", "receipt-json", "identities-missing", "wal", "shm", "journal", "index-lock", "mutation-lock", "temporary"]) test("okf:17 " + damage + " stays visible and byte-identical", () => {
  const vault = fresh(); configureModels(vault); note(vault); succeeds(vault, ["search", "sync"]);
  const search = path.join(vault, ".wiki/search");
  if (damage === "database-corrupt") fs.writeFileSync(path.join(search, "qmd.sqlite"), "Broken SQLite bytes");
  if (damage === "database-missing") fs.unlinkSync(path.join(search, "qmd.sqlite"));
  if (damage === "receipt-missing") fs.unlinkSync(path.join(search, "coverage.json"));
  if (damage === "receipt-json") fs.writeFileSync(path.join(search, "coverage.json"), "{bad");
  if (damage === "identities-missing") fs.unlinkSync(path.join(search, "identities.json"));
  if (["wal", "shm", "journal"].includes(damage)) fs.writeFileSync(path.join(search, "qmd.sqlite-" + damage), "retained sidecar");
  if (damage === "index-lock") fs.writeFileSync(path.join(search, "writer.lock"), "crash-left lock; never reclaim by mtime");
  if (damage === "mutation-lock") fs.writeFileSync(path.join(vault, ".wiki/locks/mutation.lock"), "writer owner");
  if (damage === "temporary") fs.writeFileSync(path.join(vault, ".wiki/tmp/retained-partial"), "partial earlier write");
  const result = doctor(vault); assert.equal(result.data.ok, false); assert.ok([3, 6, 7].includes(result.status!));
  assert.ok(result.data.diagnostics.length > 0);
  if (!["mutation-lock", "temporary"].includes(damage)) assert.notEqual(result.data.search.textCoverage.state, "complete");
});

test("okf:17 symlinked local database never opens or mutates the decoy target", () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  const file = path.join(vault, ".wiki/search/qmd.sqlite"), decoy = path.join(home, "decoy.sqlite");
  fs.copyFileSync(file, decoy); fs.unlinkSync(file); fs.symlinkSync(decoy, file);
  const result = doctor(vault); assert.equal(result.data.search.textCoverage.state, "unavailable");
  assert.match(JSON.stringify(result.data.diagnostics), /symlink/);
});

for (const args of [["doctor", "extra"], ["doctor", "--check"], ["doctor", "--section", "Intro"], ["doctor", "--folder", "notes"], ["doctor", "--personal"]]) test("okf:17 rejects doctor usage " + args.join(" "), () => {
  const vault = fresh(), before = snapshot(vault); const result = cli(vault, args);
  assert.equal(result.status, 2); assert.deepEqual(snapshot(vault), before);
});


test("okf:17 missing requested vault reports exit 4 and creates no directory", () => {
  const vault = path.join(temp, "absent"), beforeHome = snapshot(home);
  const result = cli(vault, ["doctor"]); assert.equal(result.status, 4); assert.equal(result.data.error.code, "not_found");
  assert.equal(fs.existsSync(vault), false); assert.deepEqual(snapshot(home), beforeHome);
});

test("okf:17 empty registry and stale navigation are actionable without scaffolding or regeneration", () => {
  const empty = fresh(); fs.rmSync(path.join(empty, ".wiki/types"), { recursive: true }); fs.mkdirSync(path.join(empty, ".wiki/types"));
  const missing = doctor(empty); assert.equal(missing.data.registry.state, "unavailable"); assert.match(JSON.stringify(missing.data.diagnostics), /Missing registry records/);
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]); fs.appendFileSync(path.join(vault, "personal/index.md"), "Edited generated index\n");
  const stale = doctor(vault); assert.equal(stale.status, 6); assert.equal(stale.data.navigation.state, "unavailable"); assert.equal(stale.data.search.textCoverage.state, "complete");
  assert.ok(stale.data.diagnostics.some((d: { path: string; fix: string }) => d.path === "personal/index.md" && /index/.test(d.fix)));
});

for (const table of ["documents_fts", "content_vectors"]) test("okf:17 damaged " + table + " schema is not silently repaired by SDK initialization", async () => {
  const vault = fresh(); configureModels(vault); note(vault); succeeds(vault, ["search", "sync"]);
  const { createStore } = await import("@tobilu/qmd");
  const store = await createStore({ dbPath: path.join(vault, ".wiki/search/qmd.sqlite"), config: { collections: {} } });
  try { store.internal.db.exec("DROP TABLE " + table); } finally { await store.close(); }
  const result = doctor(vault); assert.equal(result.status, 7, JSON.stringify(result.data)); assert.equal(result.data.search.database.state, "unavailable");
  assert.equal(result.data.search.textCoverage.state, "unavailable"); assert.match(JSON.stringify(result.data.diagnostics), new RegExp(table));
});

test("okf:17 empty inventory does not make an invalid identity-mapping version compatible", () => {
  const vault = fresh(); configureModels(vault); succeeds(vault, ["search", "sync"]);
  fs.writeFileSync(path.join(vault, ".wiki/search/identities.json"), '{"version":9,"paths":[]}');
  const result = doctor(vault); assert.equal(result.status, 6); assert.equal(result.data.search.textCoverage.state, "incomplete");
});

test("okf:17 scratch placement inside the vault is refused before creating diagnostic files", () => {
  const vault = fresh(); configureModels(vault); note(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault, { TMPDIR: vault }); assert.equal(result.status, 7); assert.equal(result.data.search.textCoverage.state, "unavailable");
  assert.match(JSON.stringify(result.data.diagnostics), /scratch directory must be outside/);
});


test("okf:17 interrupted embedding metadata without physical vectors cannot report healthy embeddings", async () => {
  const vault = fresh(); configureModels(vault); note(vault); succeeds(vault, ["search", "sync"]);
  const { createStore } = await import("@tobilu/qmd");
  const store = await createStore({ dbPath: path.join(vault, ".wiki/search/qmd.sqlite"), config: { collections: {} } });
  try {
    // QMD records metadata before writing vector bytes. This is an interrupted operation, not a model fake.
    store.internal.db.exec("INSERT INTO content_vectors(hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at) SELECT DISTINCT hash, 0, 0, 'interrupted-model', 'partial', 1, '2026-01-01' FROM documents WHERE active = 1");
  } finally { await store.close(); }
  const result = doctor(vault); assert.equal(result.status, 6, JSON.stringify(result.data));
  assert.equal(result.data.search.textCoverage.state, "complete");
  assert.equal(result.data.search.database.state, "unavailable"); assert.equal(result.data.search.embeddingCoverage.state, "unavailable");
  assert.match(JSON.stringify(result.data.diagnostics), /vector/);
});


test("okf:17 diagnostic native close failure keeps a structured report and never certifies coverage", () => {
  const vault = fresh(); configureModels(vault); note(vault); succeeds(vault, ["search", "sync"]);
  const result = doctor(vault, { OKF_DOCTOR_GUARD: "close-failure" }); assert.equal(result.status, 7);
  assert.equal(result.data.search.textCoverage.state, "unavailable"); assert.equal(result.data.search.embeddingCoverage.state, "unavailable");
  assert.match(JSON.stringify(result.data.diagnostics), /Diagnostic database close failed.*SQLITE_IOERR/);
});
