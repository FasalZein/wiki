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
import "./qmd-cleanup-guard.js";
import { syncQmdText, searchQmdLex } from "../src/qmd.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-qmd-"));
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

test("okf:10 real SDK adds exact full Markdown without embeddings and retrieves lexical matches", async () => {
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
  assert.match(result.textCoverage.inventory[0]?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
});

function receipt(root: string) { return path.join(root, ".wiki/search/coverage.json"); }
async function paths(root: string, query: string) {
  const found = await searchQmdLex(root, query, 100);
  assert.equal(found.state, "successful", JSON.stringify(found));
  return found.matches.map(m => m.path);
}

test("okf:10 same-size same-mtime edits, additions, removals, and same-content renames follow full captured bytes", async () => {
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

test("okf:10 derived state deletion rebuilds exact coverage, including shared-content identities", async () => {
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

test("okf:10 caller diagnostics and forbidden supplied paths never claim complete coverage or enter retrieval", async () => {
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
  test("okf:10 " + mode + " at actual SDK progress invalidates receipt and permits explicit recovery", async () => {
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

test("okf:10 SDK-skipped empty content cannot pass indexed-body verification", async () => {
  const root = fresh();
  const result = await syncQmdText(root, inventory([note("empty", "")]));
  assert.equal(result.state, "unavailable", JSON.stringify(result));
  assert.match(JSON.stringify(result), /Indexed Markdown differs/);
  assert.equal(fs.existsSync(receipt(root)), false);
});

test("okf:10 exclusive writer lock rejects competing sync and lexical reads without taking the mutation lock", async () => {
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

test("okf:10 native database failures, duplicate captures, and symlinks fail closed", async () => {
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


test("okf:10 valid build/dist/vendor project and folder identities survive SDK exclusions, rename, and rebuild", async () => {
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

test("okf:10 SDK progress failure plus permission-denied cleanup preserves both diagnostics and retained-lock recovery", async () => {
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

test("okf:10 native close failures stay structured after real lexical reads and prevent successful sync receipts", async () => {
  const root = fresh();
  const good = inventory([note("first", "# First\nQuasar\n")]);
  assert.equal((await syncQmdText(root, good)).state, "successful");
  process.env.OKF_QMD_FAIL_CLOSE = "yes";
  let found;
  try { found = await searchQmdLex(root, "quasar"); }
  finally { delete process.env.OKF_QMD_FAIL_CLOSE; }
  assert.equal(found.state, "unavailable", JSON.stringify(found));
  assert.match(JSON.stringify(found), /injected native SQLITE_IOERR/);
  assert.equal(fs.existsSync(path.join(root, ".wiki/search/writer.lock")), false);
  process.env.OKF_QMD_FAIL_CLOSE = "yes";
  let sync;
  try { sync = await syncQmdText(root, good); }
  finally { delete process.env.OKF_QMD_FAIL_CLOSE; }
  assert.equal(sync.state, "unavailable", JSON.stringify(sync));
  assert.match(JSON.stringify(sync), /injected native SQLITE_IOERR/);
  assert.equal(fs.existsSync(receipt(root)), false);
  assert.equal(fs.existsSync(path.join(root, ".wiki/search/writer.lock")), false);
});


test("okf:10 checked staged mapping rejects forged, duplicate, or unmapped canonical identities", async () => {
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
