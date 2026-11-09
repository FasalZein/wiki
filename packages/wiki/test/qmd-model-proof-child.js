// Child of qmd-model-proof.js. Explicit local-model proof, not a model-free test.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import cp from "node:child_process";

const supplied = process.env.WIKI_QMD_MODEL_DIR;
assert.ok(supplied, "Supply existing local models through WIKI_QMD_MODEL_DIR");
const models = {
  embed: path.resolve(supplied, "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"),
  generate: path.resolve(supplied, "hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"),
  rerank: path.resolve(supplied, "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"),
};
const sandbox = process.env.WIKI_QMD_SANDBOX;
assert.ok(sandbox);
const home = path.join(sandbox, "home");
fs.mkdirSync(home);
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, "config");
process.env.XDG_CACHE_HOME = path.join(home, "cache");
process.env.XDG_DATA_HOME = path.join(home, "data");
process.env.TMPDIR = sandbox;
process.env.QMD_EMBED_PARALLELISM = "1";
process.env.QMD_EXPAND_CONTEXT_SIZE = "1024";
process.env.QMD_RERANK_CONTEXT_SIZE = "1024";
process.env.QMD_EMBED_CONTEXT_SIZE = "512";
let networkAttempts = 0;
let subprocessAttempts = 0;
let forbiddenWrites = 0;
const denyNetwork = () => { networkAttempts++; throw new Error("Forbidden network/download during local-model proof"); };
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
globalThis.fetch = denyNetwork;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cp[name] = (...args) => { subprocessAttempts++; fs.writeSync(2, "Blocked subprocess " + name + " " + String(args[0]) + "\n"); throw new Error("Forbidden subprocess/native build during local-model proof"); };
}
function writable(file) {
  if (typeof file === "number") return;
  const value = file instanceof URL ? fileURLToPath(file) : String(file);
  const full = path.resolve(value);
  if (full === sandbox || full.startsWith(sandbox + path.sep) || ["/dev/null", "/dev/stdout", "/dev/stderr"].includes(full)) return;
  forbiddenWrites++;
  fs.writeSync(2, "Blocked write " + full + "\n");
  throw new Error("Forbidden write outside isolated proof state: " + full);
}
for (const target of [fs, fsp]) {
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "rm", "rmSync", "unlink", "unlinkSync", "chmod", "chmodSync", "utimes", "utimesSync", "truncate", "truncateSync"]) {
    if (!(name in target)) continue;
    const original = target[name];
    target[name] = function(file, ...args) { writable(file); return original.call(this, file, ...args); };
  }
  for (const name of ["rename", "renameSync", "copyFile", "copyFileSync"]) {
    if (!(name in target)) continue;
    const original = target[name];
    target[name] = function(from, to, ...args) { if (name.startsWith("rename")) writable(from); writable(to); return original.call(this, from, to, ...args); };
  }
  for (const name of ["open", "openSync"]) {
    if (!(name in target)) continue;
    const original = target[name];
    target[name] = function(file, flags, ...args) {
      if (flags !== "r" && flags !== "rs" && flags !== fs.constants.O_RDONLY) writable(file);
      return original.call(this, file, flags, ...args);
    };
  }
}
// QMD 2.8.3 token-based chunking uses a global tokenizer, not the store LLM.
// Configure both through the supported environment and store config boundaries.
process.env.QMD_EMBED_MODEL = models.embed;
syncBuiltinESMExports();
async function hashModel(file) {
  assert.equal(fs.lstatSync(file).isFile(), true, "Expected an existing regular GGUF file");
  const fd = fs.openSync(file, "r");
  try { const header = Buffer.alloc(4); fs.readSync(fd, header); assert.equal(header.toString(), "GGUF"); }
  finally { fs.closeSync(fd); }
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

await (async () => {
  let store;
  const before = {};
  try {
    fs.writeSync(2, "proof stage: hashing existing models\n");
    for (const [kind, file] of Object.entries(models)) before[kind] = await hashModel(file);
    fs.writeSync(2, "proof stage: import SDK and create isolated store\n");
    const { createStore } = await import("@tobilu/qmd");
    const notes = path.join(sandbox, "notes");
    fs.mkdirSync(notes);
    fs.writeFileSync(path.join(notes, "observatory.md"), "# Observatory\nAn observatory uses a telescope to observe stars and galaxies.\n");
    fs.writeFileSync(path.join(notes, "garden.md"), "# Garden\nA garden grows tomatoes in rich soil.\n");
    store = await createStore({ dbPath: path.join(sandbox, "qmd.sqlite"), config: { models, collections: { synthetic: { path: notes, pattern: "**/*.md" } } } });
    const updated = await store.update();
    assert.equal(updated.indexed, 2);
    fs.writeSync(2, "proof stage: import native runtime\n");
    await import("node-llama-cpp");
    fs.writeSync(2, "proof stage: native import finished, embed via local model\n");
    const embedded = await store.embed();
    fs.writeSync(2, "proof stage: embedding finished\n");
    assert.equal(embedded.errors, 0, JSON.stringify(embedded));
    assert.equal(embedded.docsProcessed, 2);
    assert.ok(embedded.chunksEmbedded >= 2);
    assert.equal((await store.getStatus()).needsEmbedding, 0);
    console.error("embed " + JSON.stringify(embedded));
    const question = "What instrument observes stars at an observatory?";
    const vector = await store.search({ queries: [{ type: "vec", query: question }], rerank: false, limit: 2 });
    assert.equal(vector[0]?.file, "qmd://synthetic/observatory.md", JSON.stringify(vector));
    console.error("vector only " + JSON.stringify(vector.map(({ file, score }) => ({ file, score }))));
    fs.writeSync(2, "proof stage: typed hybrid\n");
    const hybrid = await store.search({ queries: [{ type: "lex", query: "observatory" }, { type: "vec", query: question }], rerank: false, limit: 2 });
    assert.ok(hybrid.some(match => match.file === "qmd://synthetic/observatory.md"), JSON.stringify(hybrid));
    console.error("typed hybrid " + JSON.stringify(hybrid.map(({ file, score }) => ({ file, score }))));
    fs.writeSync(2, "proof stage: expansion\n");
    const expanded = await store.expandQuery(question);
    assert.ok(expanded.length > 0);
    assert.ok(expanded.every(q => ["lex", "vec", "hyde"].includes(q.type) && q.query.trim()));
    console.error("expansion " + JSON.stringify(expanded));
    fs.writeSync(2, "proof stage: rerank\n");
    const deep = await store.search({ queries: [{ type: "lex", query: "observatory" }, ...expanded], rerank: true, limit: 2, explain: true });
    assert.equal(deep[0]?.file, "qmd://synthetic/observatory.md", JSON.stringify(deep));
    assert.ok(deep.some(match => typeof match.explain?.rerankScore === "number"), JSON.stringify(deep));
    console.error("rerank " + JSON.stringify(deep.map(({ file, score, explain }) => ({ file, score, rerankScore: explain?.rerankScore }))));
    fs.writeSync(2, "proof stage: close\n");
    await store.close();
    store = undefined;
  } finally {
    try { await store?.close(); }
    finally {
      for (const [kind, file] of Object.entries(models)) {
        if (before[kind]) assert.equal(await hashModel(file), before[kind], "Existing model changed: " + kind);
      }
      assert.equal(networkAttempts, 0);
      assert.equal(subprocessAttempts, 0);
      assert.equal(forbiddenWrites, 0);
      assert.equal(fs.existsSync(path.join(home, "config")), false);
      console.error(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, models: before, networkAttempts, subprocessAttempts, forbiddenWrites }));
    }
  }
})();
