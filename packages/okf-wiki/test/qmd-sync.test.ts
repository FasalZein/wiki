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
  const found = await searchQmdLex(root, query);
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
