// Child of qmd-model-proof.js when OKF_QMD_PROOF=find. Real local-model smoke of
// the product CLI: search sync --embed, fast find and deep find, under the parent's
// OS sandbox (no network, writes only in the sandbox). Never downloads models.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const supplied = process.env.OKF_QMD_MODEL_DIR, sandbox = process.env.OKF_QMD_SANDBOX;
assert.ok(supplied && sandbox, "Supply existing local models and the parent sandbox");
const models = {
  embed: path.resolve(supplied, "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"),
  generate: path.resolve(supplied, "hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"),
  rerank: path.resolve(supplied, "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"),
};
const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const home = path.join(sandbox, "home");
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"), TMPDIR: sandbox,
  WIKI_VAULT: "", QMD_EMBED_MODEL: "", QMD_EMBED_PARALLELISM: "1", QMD_EXPAND_CONTEXT_SIZE: "1024", QMD_RERANK_CONTEXT_SIZE: "1024", QMD_EMBED_CONTEXT_SIZE: "512" };
const vault = path.join(sandbox, "vault");
function cli(...args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [BIN, "--vault", vault, "--json", ...args], { env, encoding: "utf8", timeout: 600000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null, result.stderr);
  const data = JSON.parse(result.stdout);
  console.error("cli " + JSON.stringify({ args, status: result.status, ms: Date.now() - started, data }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return data;
}
function sha(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
const before = Object.fromEntries(Object.entries(models).map(([k, f]) => [k, sha(f)]));
cli("init");
const config = path.join(vault, ".wiki/config.json");
fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), search: { models } }, null, 2) + "\n");
const star = cli("new", "note", "--personal", "--title", "Observatory", "--description", "An observatory uses a telescope to observe stars and galaxies").path;
cli("new", "note", "--personal", "--title", "Garden", "--description", "A garden grows tomatoes in rich soil");
const embedded = cli("search", "sync", "--embed");
assert.equal(embedded.embedding, "complete"); assert.deepEqual(embedded.embeddingCoverage, { state: "complete" }); assert.equal(embedded.textCoverage.state, "complete");
const question = "What instrument observes stars at an observatory?";
const fast = cli("find", question);
assert.equal(fast.mode, "fast"); assert.equal(fast.rerank, false); assert.deepEqual(fast.queries, [{ type: "lex", query: question }, { type: "vec", query: question }]);
assert.equal(fast.matches[0]?.path, star, JSON.stringify(fast.matches));
const vectorOnly = cli("find", "astronomy instrument for distant galaxies", "--terms", "zzznolexicalhit");
assert.equal(vectorOnly.matches[0]?.path, star, "Vector half retrieves without a lexical hit: " + JSON.stringify(vectorOnly.matches));
const deep = cli("find", "--deep", question);
assert.equal(deep.mode, "deep"); assert.equal(deep.rerank, true); assert.ok(deep.queries.length > 0 && deep.queries.every(q => ["lex", "vec", "hyde"].includes(q.type)));
assert.equal(deep.matches[0]?.path, star, JSON.stringify(deep.matches));
for (const [k, f] of Object.entries(models)) assert.equal(sha(f), before[k], "Model changed: " + k);
assert.equal(fs.existsSync(path.join(home, "config")), false);
const pkg = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL("../node_modules/" + name + "/package.json", import.meta.url)), "utf8")).version;
console.error("find smoke " + JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, qmd: pkg("@tobilu/qmd"), nodeLlamaCpp: pkg("node-llama-cpp"), models: Object.fromEntries(Object.entries(models).map(([k, f]) => [k, { file: path.basename(f), sha256: before[k] }])) }));
