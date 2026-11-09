import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import "./qmd-cleanup-guard.js";
import { DatabaseSync } from "node:sqlite";
import { syncQmdText, searchQmdLex, findQmd } from "../src/qmd.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-qmd-"));
// Importing the adapter does not import QMD. Sandbox all SDK defaults before first use.
const home = path.join(temp, "home");
fs.mkdirSync(home);
process.env.HOME = home;
process.env.XDG_CACHE_HOME = path.join(home, "cache");
process.env.XDG_CONFIG_HOME = path.join(home, "config");
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error("Forbidden network/model download"); };
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = deny;
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
after(() => {
  try {
    assert.equal(networkAttempts, 0, "No SDK operation may attempt network access");
    assert.deepEqual(fs.readdirSync(home), [], "No global configuration, database, or model cache writes");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
let sequence = 0;
function fresh() { const root = path.join(temp, String(++sequence)); fs.mkdirSync(root); return root; }
const note = (name: string, markdown: string) => ({ path: "personal/notes/" + name + ".md", markdown });
const inventory = (concepts: ReturnType<typeof note>[]) => ({ concepts, diagnostics: [] });

test("wiki:10 real SDK adds exact full Markdown without embeddings and retrieves lexical matches", async () => {
  const root = fresh();
  const markdown = "\uFEFF---\r\ntype: note\r\n---\r\n# Café\r\n\r\nQuasar observatory trailing spaces  \r\n";
  const result = await syncQmdText(root, inventory([note("quasar", markdown)]));
  assert.equal(result.textCoverage.state, "complete", JSON.stringify(result));
  assert.deepEqual(result.embeddingCoverage, { state: "pending", contentHashes: 1 });
  assert.equal(result.state, "successful");
  const found = await searchQmdLex(root, "quasar");
  assert.equal(found.state, "successful", JSON.stringify(found));
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0]?.path, "personal/notes/quasar.md");
  assert.equal(found.matches[0]?.markdown, markdown);
  if (result.textCoverage.state === "complete") assert.equal(result.textCoverage.inventoryCount, 1);
  assert.match(result.state === "successful" ? result.textCoverage.inventoryDigest : "", /^sha256:[a-f0-9]{64}$/);
});

function receipt(root: string) { return path.join(root, ".wiki/search/coverage.json"); }
async function paths(root: string, query: string) {
  const found = await searchQmdLex(root, query, 100);
  assert.equal(found.state, "successful", JSON.stringify(found));
  return found.matches.map(m => m.path);
}

test("wiki:10 same-size same-mtime edits, additions, removals, and same-content renames follow full captured bytes", async () => {
  const root = fresh();
  const source = path.join(root, "personal/notes/star.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "# Orion\nViolet photon\n");
  const modified = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(source, modified, modified);
  const first = await syncQmdText(root, inventory([note("star", fs.readFileSync(source, "utf8"))]));
  assert.equal(first.state, "successful");
  const firstReceipt = fs.readFileSync(receipt(root), "utf8");
  const size = fs.statSync(source).size;
  fs.writeFileSync(source, "# Orion\nYellow photon\n");
  fs.utimesSync(source, modified, modified);
  assert.equal(fs.statSync(source).size, size);
  assert.equal(fs.statSync(source).mtimeMs, modified.getTime());
  const changed = await syncQmdText(root, inventory([note("star", fs.readFileSync(source, "utf8")), note("nova", "# Nova\nCrimson flare\n")]));
  assert.equal(changed.state, "successful", JSON.stringify(changed));
  assert.equal(changed.update.updated, 1);
  assert.equal(changed.update.indexed, 1);
  assert.notEqual(fs.readFileSync(receipt(root), "utf8"), firstReceipt);
  assert.deepEqual(await paths(root, "Violet"), []);
  assert.deepEqual(await paths(root, "Yellow"), ["personal/notes/star.md"]);
  const renamed = await syncQmdText(root, inventory([note("renamed", fs.readFileSync(source, "utf8"))]));
  assert.equal(renamed.state, "successful", JSON.stringify(renamed));
  assert.equal(renamed.update.removed, 2);
  assert.equal(renamed.update.indexed, 1);
  assert.deepEqual(await paths(root, "Yellow"), ["personal/notes/renamed.md"]);
  assert.deepEqual(await paths(root, "Crimson"), []);
  const removed = await syncQmdText(root, inventory([]));
  assert.equal(removed.state, "successful", JSON.stringify(removed));
  assert.deepEqual(removed.embeddingCoverage, { state: "complete" });
  assert.deepEqual(await paths(root, "photon"), []);
});

test("wiki:10 derived state deletion rebuilds exact coverage, including shared-content identities", async () => {
  const root = fresh();
  const retained = [note("one", "# Shared\nNebula\n"), note("two", "# Shared\nNebula\n")];
  for (const concept of retained) {
    fs.mkdirSync(path.dirname(path.join(root, concept.path)), { recursive: true });
    fs.writeFileSync(path.join(root, concept.path), concept.markdown);
  }
  const capture = () => inventory(retained.map(concept => ({ path: concept.path, markdown: fs.readFileSync(path.join(root, concept.path), "utf8") })));
  const input = capture();
  const initial = await syncQmdText(root, input);
  assert.equal(initial.state, "successful");
  assert.deepEqual(initial.embeddingCoverage, { state: "pending", contentHashes: 1 });
  const successful = fs.readFileSync(receipt(root), "utf8");
  fs.rmSync(path.join(root, ".wiki/search"), { recursive: true });
  const rebuilt = await syncQmdText(root, capture());
  assert.equal(rebuilt.state, "successful", JSON.stringify(rebuilt));
  assert.equal(fs.readFileSync(receipt(root), "utf8"), successful);
  assert.deepEqual((await paths(root, "Nebula")).sort(), ["personal/notes/one.md", "personal/notes/two.md"]);
});

test("wiki:10 caller diagnostics and forbidden supplied paths never claim complete coverage or enter retrieval", async () => {
  const root = fresh();
  const good = note("valid", "# Valid\nAdmitted pulsar\n");
  assert.equal((await syncQmdText(root, inventory([good]))).state, "successful");
  const forbidden = ["index.md", "log.md", "personal/index.md", "personal/notes/index.md", "personal/assets/asset.md", ".wiki/config.md", "projects/app/assets/source.md", "../escape.md"];
  const result = await syncQmdText(root, {
    concepts: [good, ...forbidden.map(p => ({ path: p, markdown: "# Forbidden\nUnindexed secret\n" }))],
    diagnostics: [{ path: "personal/notes/unreadable.md", message: "EACCES while capturing" }, { path: "personal/notes/invalid.md", message: "Unknown registered type" }],
  });
  assert.equal(result.state, "incomplete", JSON.stringify(result));
  assert.equal(result.textCoverage.state, "incomplete");
  if (result.textCoverage.state === "incomplete") assert.equal(result.textCoverage.diagnostics.length, forbidden.length + 2);
  assert.equal(fs.existsSync(receipt(root)), false);
  assert.deepEqual(await paths(root, "Unindexed"), []);
  assert.deepEqual(await paths(root, "Admitted"), [good.path]);
});

for (const mode of ["abort", "throw"] as const) {
  test("wiki:10 " + mode + " at actual SDK progress invalidates receipt and permits explicit recovery", async () => {
    const root = fresh();
    const good = inventory([note("first", "# First\nInitial comet\n")]);
    assert.equal((await syncQmdText(root, good)).state, "successful");
    const controller = new AbortController();
    let events = 0;
    const failed = await syncQmdText(root, inventory([note("first", "# First\nChanged comet\n"), note("next", "# Next\nMeteor\n")]), {
      signal: controller.signal, onProgress() {
        events++;
        if (mode === "abort") controller.abort(new Error("intentional cancellation"));
        else throw new Error("intentional progress failure");
      },
    });
    assert.equal(events, 1);
    assert.equal(failed.state, "unavailable", JSON.stringify(failed));
    assert.equal(failed.textCoverage.state, "unavailable");
    assert.deepEqual(failed.embeddingCoverage, { state: "unavailable" });
    assert.equal(fs.existsSync(receipt(root)), false);
    assert.equal(fs.existsSync(path.join(root, ".wiki/search/writer.lock")), false);
    assert.equal((await syncQmdText(root, good)).state, "successful");
    assert.deepEqual(await paths(root, "Initial"), ["personal/notes/first.md"]);
  });
}

test("wiki:10 SDK-skipped empty content cannot pass indexed-body verification", async () => {
  const root = fresh();
  const result = await syncQmdText(root, inventory([note("empty", "")]));
  assert.equal(result.state, "unavailable", JSON.stringify(result));
  assert.match(JSON.stringify(result), /Indexed Markdown differs/);
  assert.equal(fs.existsSync(receipt(root)), false);
});

/** Rewrites one indexed body in place under its unchanged content hash: only an exact body comparison can see it. */
function tamperIndexedBody(root: string, markdown: string, replacement: string) {
  const db = new DatabaseSync(path.join(root, ".wiki/search/qmd.sqlite"));
  try {
    const hash = createHash("sha256").update(markdown).digest("hex");
    assert.equal(db.prepare("UPDATE content SET doc = ? WHERE hash = ?").run(replacement, hash).changes, 1);
  } finally { db.close(); }
}

test("wiki:10 an indexed body that differs from the captured Markdown under the same content hash is a find index mismatch and fails sync", async () => {
  const root = fresh();
  const good = inventory([note("star", "# Star\nGalaxy\n"), note("nova", "# Nova\nFlare\n")]);
  fs.mkdirSync(path.join(root, "personal/notes"), { recursive: true });
  for (const concept of good.concepts) fs.writeFileSync(path.join(root, concept.path), concept.markdown);
  assert.equal((await syncQmdText(root, good)).state, "successful");
  tamperIndexedBody(root, "# Star\nGalaxy\n", "# Star\nGalaxx\n");
  const found = await findQmd(root, { mode: "lexical", requested: "fast", question: "flare", reason: [] }, good.concepts);
  assert.equal(found.state, "successful", JSON.stringify(found));
  assert.deepEqual(found.indexMismatch.map(d => d.path), ["personal/notes/star.md"]);
  assert.match(found.indexMismatch[0]?.message ?? "", /different revision than this request captured/);
  assert.deepEqual(found.matches.map(m => m.path), ["personal/notes/nova.md"]);
  // QMD keeps the tampered row because the file hash is unchanged; the sync body check must catch it.
  const resync = await syncQmdText(root, good);
  assert.equal(resync.state, "unavailable", JSON.stringify(resync));
  assert.match(JSON.stringify(resync), /Indexed Markdown differs from captured concept: personal\/notes\/star.md/);
  assert.equal(fs.existsSync(receipt(root)), false);
});

test("wiki:12 a query hit whose indexed body differs from the captured revision is omitted, never rendered as current", async () => {
  const root = fresh();
  const good = inventory([note("star", "# Star\nGalaxy\n"), note("nova", "# Nova\nFlare\n")]);
  fs.mkdirSync(path.join(root, "personal/notes"), { recursive: true });
  for (const concept of good.concepts) fs.writeFileSync(path.join(root, concept.path), concept.markdown);
  assert.equal((await syncQmdText(root, good)).state, "successful");
  // The stale indexed body still matches the query, so the hit reaches rendering.
  tamperIndexedBody(root, "# Star\nGalaxy\n", "# Star\nGalaxy old\n");
  const found = await findQmd(root, { mode: "lexical", requested: "fast", question: "galaxy", reason: [] }, good.concepts);
  assert.equal(found.state, "successful", JSON.stringify(found));
  assert.deepEqual(found.matches, [], "The stale indexed excerpt never leaks as current");
  assert.deepEqual(found.omitted.map(d => d.path), ["personal/notes/star.md"]);
  assert.match(found.omitted[0]?.message ?? "", /Indexed content differs from the captured revision/);
});

test("wiki:10 exclusive writer lock rejects competing sync and lexical reads without taking the mutation lock", async () => {
  const root = fresh();
  fs.mkdirSync(path.join(root, ".wiki"));
  fs.writeFileSync(path.join(root, ".wiki/mutation.lock"), "unrelated content operation");
  const first = syncQmdText(root, inventory([note("star", "# Star\nGalaxy\n")]));
  const second = await syncQmdText(root, inventory([]));
  const search = await searchQmdLex(root, "Galaxy");
  assert.equal(second.state, "unavailable");
  assert.equal(search.state, "unavailable");
  assert.match(JSON.stringify(second), /EEXIST/);
  assert.equal((await first).state, "successful");
  assert.deepEqual(await paths(root, "Galaxy"), ["personal/notes/star.md"]);
  assert.equal(fs.readFileSync(path.join(root, ".wiki/mutation.lock"), "utf8"), "unrelated content operation");
});

test("wiki:10 native database failures, duplicate captures, and symlinks fail closed", async () => {
  const corrupt = fresh();
  fs.mkdirSync(path.join(corrupt, ".wiki/search"), { recursive: true });
  fs.writeFileSync(path.join(corrupt, ".wiki/search/qmd.sqlite"), "not SQLite");
  const failed = await syncQmdText(corrupt, inventory([note("star", "# Star\nGalaxy\n")]));
  assert.equal(failed.state, "unavailable", JSON.stringify(failed));
  assert.equal(fs.existsSync(receipt(corrupt)), false);
  const duplicate = fresh();
  const one = note("one", "# One\n");
  assert.equal((await syncQmdText(duplicate, inventory([one, one]))).state, "unavailable");
  const symlink = fresh();
  const external = fresh();
  fs.symlinkSync(external, path.join(symlink, ".wiki"));
  assert.equal((await syncQmdText(symlink, inventory([one]))).state, "unavailable");
  assert.deepEqual(fs.readdirSync(external), []);
});


test("wiki:10 valid build/dist/vendor project and folder identities survive SDK exclusions, rename, and rebuild", async () => {
  const root = fresh();
  const names = ["app", "build", "dist", "vendor"];
  const concepts = names.flatMap(project => names.map(folder => ({
    path: "projects/" + project + "/" + folder + "/quasar.md", markdown: "# Quasar\nShared photon\n",
  })));
  concepts.push({ path: "personal/build/" + "long-".repeat(48) + "star.md", markdown: "# Long\nPhoton\n" });
  const result = await syncQmdText(root, inventory(concepts));
  assert.equal(result.state, "successful", JSON.stringify(result));
  assert.deepEqual((await paths(root, "photon")).sort(), concepts.map(c => c.path).sort());
  const renamed = concepts.map((c, i) => i === 0 ? { ...c, path: "projects/build/vendor/renamed.md" } : c).slice(0, -1);
  const next = await syncQmdText(root, inventory(renamed));
  assert.equal(next.state, "successful", JSON.stringify(next));
  assert.deepEqual((await paths(root, "photon")).sort(), renamed.map(c => c.path).sort());
  fs.rmSync(path.join(root, ".wiki/search"), { recursive: true });
  assert.equal((await syncQmdText(root, inventory(renamed))).state, "successful");
  assert.deepEqual((await paths(root, "photon")).sort(), renamed.map(c => c.path).sort());
});

test("wiki:10 SDK progress failure plus permission-denied cleanup preserves both diagnostics and retained-lock recovery", async () => {
  const root = fresh();
  const good = inventory([note("first", "# First\nQuasar\n")]);
  assert.equal((await syncQmdText(root, good)).state, "successful");
  const directory = path.join(root, ".wiki/search");
  let result;
  try {
    result = await syncQmdText(root, inventory([note("first", "# First\nChanged\n")]), { onProgress() {
      fs.chmodSync(directory, 0o500);
      throw new Error("original SDK progress failure");
    } });
  } finally { fs.chmodSync(directory, 0o700); }
  assert.equal(result.state, "unavailable", JSON.stringify(result));
  const record = JSON.stringify(result);
  assert.match(record, /original SDK progress failure/);
  assert.match(record, /EACCES/);
  assert.match(record, /confirm no index writer is active/);
  assert.equal(fs.existsSync(receipt(root)), false);
  assert.equal(fs.existsSync(path.join(directory, "writer.lock")), true);
  // Recovery is explicit and only after the failed call has released all resources.
  fs.unlinkSync(path.join(directory, "writer.lock"));
  assert.equal((await syncQmdText(root, good)).state, "successful");
});

test("wiki:10 native close failures stay structured after real lexical reads and prevent successful sync receipts", async () => {
  const root = fresh();
  const good = inventory([note("first", "# First\nQuasar\n")]);
  assert.equal((await syncQmdText(root, good)).state, "successful");
  process.env.WIKI_QMD_FAIL_CLOSE = "yes";
  let found;
  try { found = await searchQmdLex(root, "quasar"); }
  finally { delete process.env.WIKI_QMD_FAIL_CLOSE; }
  assert.equal(found.state, "unavailable", JSON.stringify(found));
  assert.match(JSON.stringify(found), /injected native SQLITE_IOERR/);
  assert.equal(fs.existsSync(path.join(root, ".wiki/search/writer.lock")), false);
  process.env.WIKI_QMD_FAIL_CLOSE = "yes";
  let sync;
  try { sync = await syncQmdText(root, good); }
  finally { delete process.env.WIKI_QMD_FAIL_CLOSE; }
  assert.equal(sync.state, "unavailable", JSON.stringify(sync));
  assert.match(JSON.stringify(sync), /injected native SQLITE_IOERR/);
  assert.equal(fs.existsSync(receipt(root)), false);
  assert.equal(fs.existsSync(path.join(root, ".wiki/search/writer.lock")), false);
});


test("wiki:10 checked staged mapping rejects forged, duplicate, or unmapped canonical identities", async () => {
  const root = fresh();
  const good = inventory([note("first", "# First\nQuasar\n")]);
  assert.equal((await syncQmdText(root, good)).state, "successful");
  const file = path.join(root, ".wiki/search/identities.json");
  const mapping = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(mapping);
  assert.match(raw.paths[0].id, /^[a-f0-9]{64}\.md$/);
  raw.paths[0].path = "projects/dist/vendor/forged.md";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal((await searchQmdLex(root, "quasar")).state, "unavailable");
  const duplicate = JSON.parse(mapping);
  duplicate.paths.push(duplicate.paths[0]);
  fs.writeFileSync(file, JSON.stringify(duplicate));
  assert.equal((await searchQmdLex(root, "quasar")).state, "unavailable");
  fs.writeFileSync(file, JSON.stringify({ version: 1, paths: [] }));
  assert.equal((await searchQmdLex(root, "quasar")).state, "unavailable");
  fs.writeFileSync(file, mapping);
  assert.deepEqual(await paths(root, "quasar"), ["personal/notes/first.md"]);
});

// Hardener additions: each test pins one observable contract of syncQmdText/searchQmdLex.
const sha256 = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");

test("wiki:10 lexical limit accepts only positive safe integers and caps returned matches", async () => {
  const root = fresh();
  assert.equal((await syncQmdText(root, inventory([note("a", "# A\nPlasma\n"), note("b", "# B\nPlasma\n")]))).state, "successful");
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    const rejected = await searchQmdLex(root, "Plasma", limit);
    assert.equal(rejected.state, "unavailable", String(limit));
    assert.match(JSON.stringify(rejected), /Expected a positive integer lexical limit/);
  }
  const one = await searchQmdLex(root, "Plasma", 1);
  assert.equal(one.state, "successful", JSON.stringify(one));
  assert.equal(one.matches.length, 1);
});

test("wiki:10 lexical search before any synchronization reports a missing text index", async () => {
  const root = fresh();
  const found = await searchQmdLex(root, "anything");
  assert.equal(found.state, "unavailable");
  assert.match(JSON.stringify(found), /Text index unavailable; synchronize captured concepts first/);
});

test("wiki:10 coverage receipt lists captured concepts sorted by canonical path with content digests", async () => {
  const root = fresh();
  const concepts = [note("zeta", "# Zeta\n"), note("alpha", "# Alpha\n"), note("mid", "# Mid\n")];
  const result = await syncQmdText(root, inventory(concepts));
  assert.equal(result.state, "successful", JSON.stringify(result));
  const expected = [
    { path: "personal/notes/alpha.md", digest: sha256("# Alpha\n") },
    { path: "personal/notes/mid.md", digest: sha256("# Mid\n") },
    { path: "personal/notes/zeta.md", digest: sha256("# Zeta\n") },
  ];
  // README contract: inventoryDigest is sha256 over the exact inventory array bytes the receipt stores.
  const stored = fs.readFileSync(receipt(root), "utf8");
  assert.equal(stored, JSON.stringify({ version: 1, inventory: expected }) + "\n");
  const arrayBytes = stored.slice(stored.indexOf("["), stored.lastIndexOf("]") + 1);
  assert.deepEqual(result.textCoverage, { state: "complete", inventoryCount: 3, inventoryDigest: sha256(arrayBytes) });
  assert.equal(sha256(JSON.stringify(JSON.parse(stored).inventory)), sha256(arrayBytes), "Re-serializing the parsed receipt reproduces the digest");
});

test("wiki:10 failure codes distinguish a busy writer from other unavailability", async () => {
  const busy = fresh();
  fs.mkdirSync(path.join(busy, ".wiki/search"), { recursive: true });
  fs.writeFileSync(path.join(busy, ".wiki/search/writer.lock"), "other writer");
  const conflict = await syncQmdText(busy, inventory([]));
  assert.equal(conflict.state, "unavailable");
  if (conflict.state === "unavailable") assert.equal(conflict.code, "conflict");
  const corrupt = fresh();
  fs.mkdirSync(path.join(corrupt, ".wiki/search"), { recursive: true });
  fs.writeFileSync(path.join(corrupt, ".wiki/search/qmd.sqlite"), "not SQLite");
  const failed = await syncQmdText(corrupt, inventory([note("star", "# Star\n")]));
  assert.equal(failed.state, "unavailable");
  if (failed.state === "unavailable") assert.equal(failed.code, "unavailable");
});

test("wiki:10 invalid Unicode Markdown and forbidden paths are reported per concept", async () => {
  const root = fresh();
  const broken = await syncQmdText(root, inventory([note("lone", "# Lone \uD800 surrogate\n")]));
  assert.equal(broken.state, "unavailable");
  assert.match(JSON.stringify(broken), /Invalid Unicode Markdown: personal\/notes\/lone\.md/);
  const mixed = await syncQmdText(root, { concepts: [note("ok", "# Ok\n"), { path: "personal/index.md", markdown: "# Index\n" }], diagnostics: [] });
  assert.equal(mixed.state, "incomplete", JSON.stringify(mixed));
  if (mixed.state === "incomplete") {
    assert.deepEqual(mixed.textCoverage.diagnostics.map(d => d.path), ["personal/index.md"]);
    assert.match(mixed.textCoverage.diagnostics[0]?.message ?? "", /Expected a validated concept/);
  }
});

test("wiki:10 abort at the last check before publishing leaves neither coverage nor identity mapping", async () => {
  const root = fresh();
  const good = inventory([note("first", "# First\nComet\n")]);
  let calls = 0;
  const counting = { throwIfAborted() { calls++; } } as unknown as AbortSignal;
  assert.equal((await syncQmdText(root, good, { signal: counting })).state, "successful");
  const last = calls;
  assert.ok(last > 1);
  let seen = 0;
  const abortLast = { throwIfAborted() { if (++seen === last) throw new Error("late abort"); } } as unknown as AbortSignal;
  const failed = await syncQmdText(root, good, { signal: abortLast });
  assert.equal(failed.state, "unavailable", JSON.stringify(failed));
  assert.match(JSON.stringify(failed), /late abort/);
  assert.equal(fs.existsSync(receipt(root)), false);
  assert.equal(fs.existsSync(path.join(root, ".wiki/search/identities.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".wiki/search/writer.lock")), false);
});
test("wiki:10 malformed identity mappings are rejected as invalid before lexical results are mapped", async () => {
  const root = fresh();
  assert.equal((await syncQmdText(root, inventory([note("first", "# First\nQuasar\n")]))).state, "successful");
  const file = path.join(root, ".wiki/search/identities.json");
  const mapping = JSON.parse(fs.readFileSync(file, "utf8"));
  const row = mapping.paths[0];
  const documents = [null, 7, [], {}, { version: 2, paths: [row] }, { version: 1 }, { version: 1, paths: {} }];
  const rows = [null, 7, { path: row.path }, { id: [row.id], path: row.path }, { id: 7, path: row.path }, { id: row.id }, { id: row.id, path: 7 }];
  const cases = [
    ...documents.map(value => ({ value, expected: /Invalid staged identity mapping/ })),
    ...rows.map(bad => ({ value: { version: 1, paths: [bad] }, expected: /Invalid or duplicate staged identity/ })),
  ];
  for (const { value, expected } of cases) {
    fs.writeFileSync(file, JSON.stringify(value));
    const found = await searchQmdLex(root, "quasar");
    assert.equal(found.state, "unavailable", JSON.stringify(value));
    assert.match(JSON.stringify(found), expected, JSON.stringify(value));
  }
});

test("wiki:10 SDK cache and config levels must be real directories; existing directories are accepted", async () => {
  const cacheFile = fresh();
  fs.mkdirSync(path.join(cacheFile, ".wiki/search"), { recursive: true });
  fs.writeFileSync(path.join(cacheFile, ".wiki/search/sdk-cache"), "file");
  const cache = await syncQmdText(cacheFile, inventory([note("a", "# A\n")]));
  assert.equal(cache.state, "unavailable");
  assert.match(JSON.stringify(cache), /Expected a directory for SDK cache: .wiki\/search\/sdk-cache/);
  const configFile = fresh();
  fs.mkdirSync(path.join(configFile, ".wiki/search/sdk-config"), { recursive: true });
  fs.writeFileSync(path.join(configFile, ".wiki/search/sdk-config/qmd"), "file");
  const config = await syncQmdText(configFile, inventory([note("a", "# A\n")]));
  assert.equal(config.state, "unavailable");
  assert.match(JSON.stringify(config), /Expected a directory for SDK config: .wiki\/search\/sdk-config\/qmd/);
  const configDirectory = fresh();
  fs.mkdirSync(path.join(configDirectory, ".wiki/search/sdk-config/qmd"), { recursive: true });
  assert.equal((await syncQmdText(configDirectory, inventory([note("a", "# A\n")]))).state, "successful");
});

test("wiki:10 a symlinked SQLite sidecar fails closed without touching its target", async () => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const root = fresh();
    const external = fresh();
    fs.mkdirSync(path.join(root, ".wiki/search"), { recursive: true });
    fs.symlinkSync(path.join(external, "target"), path.join(root, ".wiki/search/qmd.sqlite" + suffix));
    const result = await syncQmdText(root, inventory([note("a", "# A\n")]));
    assert.equal(result.state, "unavailable", suffix);
    assert.deepEqual(fs.readdirSync(external), [], suffix);
  }
});

test("wiki:10 a lock-creation failure other than an existing lock is not reported as a writer conflict", async () => {
  const root = fresh();
  const directory = path.join(root, ".wiki/search");
  fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(directory, 0o500);
  let result;
  try { result = await syncQmdText(root, inventory([])); }
  finally { fs.chmodSync(directory, 0o700); }
  assert.equal(result.state, "unavailable");
  if (result.state === "unavailable") assert.equal(result.code, "unavailable");
  assert.match(JSON.stringify(result), /EACCES/);
});
