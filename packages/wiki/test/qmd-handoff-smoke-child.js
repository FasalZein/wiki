// Child of qmd-model-proof.js when WIKI_QMD_PROOF=handoff (B20, #34). Complete
// synthetic handoff smoke of the product CLI under the parent's OS sandbox (no
// network, writes only in the sandbox): init, registry/lint, create, show, stale
// update refusal, authorized update, source capture, search sync --embed, fast and
// deep find with real local models, current read of the hit, index check, doctor.
// Never downloads models; the parent proves global qmd state and models unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const supplied = process.env.WIKI_QMD_MODEL_DIR, sandbox = process.env.WIKI_QMD_SANDBOX;
assert.ok(supplied && sandbox, "Supply existing local models and the parent sandbox");
const models = {
  embed: path.resolve(supplied, "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"),
  generate: path.resolve(supplied, "hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"),
  rerank: path.resolve(supplied, "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"),
};
const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
const CLI_TIMEOUT_MS = 600000;
// Decoy home is absent and inside the sandbox, so any creation is observable.
const home = path.join(sandbox, "decoy-home");
const inherited = { ...process.env };
for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) delete inherited[key];
const env = { ...inherited, HOME: home, TMPDIR: sandbox,
  WIKI_VAULT: "", QMD_EMBED_MODEL: "", QMD_EMBED_PARALLELISM: "1", QMD_EXPAND_CONTEXT_SIZE: "1024", QMD_RERANK_CONTEXT_SIZE: "1024", QMD_EMBED_CONTEXT_SIZE: "512" };
const vault = path.join(sandbox, "vault");
function cli(expected, ...args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [BIN, "--vault", vault, "--json", ...args], { env, encoding: "utf8", timeout: CLI_TIMEOUT_MS });
  assert.equal(result.error, undefined); assert.equal(result.signal, null, result.stderr);
  const data = JSON.parse(result.stdout);
  console.error("cli " + JSON.stringify({ args, status: result.status, ms: Date.now() - started, data }));
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return data;
}
const ok = (...args) => cli(0, ...args);
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = Object.fromEntries(Object.entries(models).map(([k, f]) => [k, sha(f)]));

ok("init");
const config = path.join(vault, ".wiki/config.json");
fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), search: { models } }, null, 2) + "\n");
ok("type", "list");
ok("lint");
const star = ok("new", "note", "--personal", "--title", "Observatory", "--description", "An observatory uses a telescope to observe stars and galaxies").path;
ok("new", "note", "--personal", "--title", "Garden", "--description", "A garden grows tomatoes in rich soil");

// Handoff apply: refuse a stale base, then apply with the digest from show.
const shown = ok("show", star);
const candidate = path.join(sandbox, "candidate.md");
fs.writeFileSync(candidate, shown.markdown + "\nThe main telescope is a reflecting telescope with a large mirror.\n");
const refused = cli(3, "update", star, "--expect", "sha256:" + "0".repeat(64), "--file", candidate);
assert.equal(refused.error.code, "conflict");
assert.equal("sha256:" + sha(path.join(vault, star)), shown.digest, "Refused update changed the topic");
const updated = ok("update", star, "--expect", shown.digest, "--file", candidate);
assert.equal(updated.outcome, "updated"); assert.equal(updated.digest, "sha256:" + sha(path.join(vault, star)));

// Source capture of a local synthetic document.
const input = path.join(sandbox, "sourdough.md");
const sourceText = "# Sourdough\n\nA sourdough starter ferments flour and water with wild yeast before baking bread.\n";
fs.writeFileSync(input, sourceText);
const captured = ok("capture", input, "--personal", "--title", "Sourdough guide", "--description", "A captured baking document");
assert.equal(captured.original_sha256, "sha256:" + sha(input));
assert.equal(fs.readFileSync(path.join(vault, captured.original), "utf8"), sourceText);
ok("index", "--check");
ok("lint");

// Isolated search with real local models.
const embedded = ok("search", "sync", "--embed");
assert.equal(embedded.embedding, "complete"); assert.deepEqual(embedded.embeddingCoverage, { state: "complete" }); assert.equal(embedded.textCoverage.state, "complete");
const question = "What instrument observes stars at an observatory?";
const fast = ok("find", question);
assert.equal(fast.mode, "fast"); assert.equal(fast.rerank, false);
assert.equal(fast.matches[0]?.path, star, JSON.stringify(fast.matches));
const deep = ok("find", "--deep", question);
assert.equal(deep.mode, "deep"); assert.equal(deep.rerank, true); assert.ok(deep.queries.length > 0);
assert.equal(deep.matches[0]?.path, star, JSON.stringify(deep.matches));
const bread = ok("find", "How do I ferment a starter for baking bread?");
assert.equal(bread.matches[0]?.path, captured.path, JSON.stringify(bread.matches));
// Current read of the hit: show returns the bytes that find revalidated.
const read = ok("show", deep.matches[0].path);
assert.equal(read.digest, deep.matches[0].digest); assert.equal(read.digest, updated.digest);
assert.match(read.markdown, /reflecting telescope/);

const doctor = ok("doctor");
assert.equal(doctor.sourceCorrectness, "not-asserted");
assert.equal(doctor.search.textCoverage.state, "complete"); assert.equal(doctor.search.embeddingCoverage.state, "complete");

for (const [k, f] of Object.entries(models)) assert.equal(sha(f), before[k], "Model changed: " + k);
assert.equal(fs.existsSync(home), false, "Product created state under the decoy home");
const vaultCache = path.join(vault, ".wiki/search/sdk-cache/qmd/models");
console.error("cache isolation " + JSON.stringify({ decoyHome: home, decoyHomeExists: fs.existsSync(home), vaultCache, vaultCacheExists: fs.existsSync(vaultCache), vaultCacheEntries: fs.existsSync(vaultCache) ? fs.readdirSync(vaultCache) : null }));
const pkg = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL("../node_modules/" + name + "/package.json", import.meta.url)), "utf8")).version;
console.error("handoff smoke " + JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, qmd: pkg("@tobilu/qmd"), nodeLlamaCpp: pkg("node-llama-cpp"), doctorRuntime: doctor.runtime, doctorExtractors: doctor.extractors, models: Object.fromEntries(Object.entries(models).map(([k, f]) => [k, { file: path.basename(f), sha256: before[k] }])) }));
