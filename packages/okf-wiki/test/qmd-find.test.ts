import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Real CLI processes over real QMD storage. Only external inference is faked
// (qmd-fake-inference.js); the real local-model smoke is qmd-model-proof.js find.
const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const GUARD = fileURLToPath(new URL("./qmd-cli-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-qmd-find-"));
after(() => {
  try {
    for (const dir of ["cache", "config", "data"]) assert.equal(fs.existsSync(path.join(temp, dir)), false, "No global-default search state: " + dir);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
let counter = 0;
type Call = { op: string; models?: Record<string, string>; tokenizer?: string; query?: string; request?: { queries: { type: string; query: string }[]; rerank: boolean } };
function cli(vault: string, args: string[], mode = "", json = true, extraEnv: Record<string, string> = {}) {
  const log = path.join(vault + ".calls.jsonl");
  fs.rmSync(log, { force: true });
  const result = spawnSync(process.execPath, ["--import", GUARD, BIN, "--vault", vault, ...(json ? ["--json"] : []), ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, HOME: temp, XDG_CACHE_HOME: path.join(temp, "cache"), XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"), WIKI_VAULT: "", QMD_EMBED_MODEL: "", OKF_QMD_CLI_GUARD: mode, OKF_QMD_CALL_LOG: log, OKF_QMD_DENY_SUBPROCESS: "1", ...extraEnv },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  if (json) assert.equal(result.stderr, "");
  const logged: Call[] = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  // The text synchronization store (createStore + model-free update) opens first.
  const textStore = logged[1]?.op === "update" ? 2 : 0;
  const calls = logged.slice(textStore);
  return { status: result.status, data: json ? JSON.parse(result.stdout) : undefined, stdout: result.stdout, stderr: result.stderr, calls, textStore, textModels: textStore ? logged[0]?.models : undefined };
}
function succeeds(vault: string, args: string[], mode = "") { const result = cli(vault, args, mode); assert.equal(result.status, 0, JSON.stringify(result)); return result; }
function fresh() { const vault = path.join(temp, String(++counter)); succeeds(vault, ["init"]); return vault; }
function note(vault: string, title: string, description: string) {
  return succeeds(vault, ["new", "note", "--personal", "--title", title, "--description", description]).data.path as string;
}
/** Placeholder GGUF files: valid local paths for readiness; never loaded because inference is faked. */
function configure(vault: string, roles: string[]) {
  const models: Record<string, string> = {};
  for (const role of roles) { const file = path.join(temp, "model-" + counter + "-" + role + ".gguf"); fs.writeFileSync(file, "GGUF placeholder"); models[role] = file; }
  const config = path.join(vault, ".wiki/config.json");
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), search: { models } }, null, 2) + "\n");
  return models;
}
const ops = (calls: Call[]) => calls.map(c => c.op);

test("okf:11 fast find forwards one typed lex/vec request without expansion or rerank, syncs text and never embeds", () => {
  const vault = fresh(), star = note(vault, "Observatory", "Observatory telescope for stars"); note(vault, "Garden", "Garden tomatoes in soil");
  const models = configure(vault, ["embed"]);
  // The fake vector half contributes nothing; this literal question is also a lexical hit.
  const question = "telescope stars";
  const result = cli(vault, ["find", question], "fake-inference");
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.textStore, 2, "Find synchronizes text first");
  assert.deepEqual(result.textModels, models, "Pending embeddings are measured against the configured embed model");
  assert.deepEqual(ops(result.calls), ["createStore", "search"], "Exactly one search; no expansion, embedding or retry");
  assert.deepEqual(result.calls[0]?.models, models); assert.equal(result.calls[0]?.tokenizer, models.embed);
  assert.deepEqual(result.calls[1]?.request?.queries, [{ type: "lex", query: question }, { type: "vec", query: question }]);
  assert.equal(result.calls[1]?.request?.rerank, false);
  assert.equal(result.data.mode, "fast"); assert.equal(result.data.rerank, false);
  assert.deepEqual(result.data.matches.map((m: { path: string }) => m.path), [star]);
  assert.equal(result.data.textCoverage.state, "complete"); assert.equal(result.data.textCoverage.inventory.length, 2);
  assert.deepEqual(result.data.embeddingCoverage, { state: "incomplete", contentHashes: 2 }, "Pending embeddings are reported separately from text coverage");
  const terms = cli(vault, ["find", question, "--terms", "garden tomatoes"], "fake-inference");
  assert.equal(terms.status, 0); assert.deepEqual(ops(terms.calls), ["createStore", "search"]);
  assert.deepEqual(terms.calls[1]?.request?.queries, [{ type: "lex", query: "garden tomatoes" }, { type: "vec", query: question }]);
  const human = cli(vault, ["find", question], "fake-inference", false);
  assert.equal(human.status, 0); assert.match(human.stdout, /Mode: fast \(one typed lex\/vec query, no expansion, no reranking\)/);
  assert.match(human.stdout, /Text coverage: complete/); assert.match(human.stdout, /Embedding coverage: incomplete \(2 content hashes pending\)/);
});

test("okf:11 fast miss never escalates to deep; deep find explicitly expands and reranks", () => {
  const vault = fresh(), star = note(vault, "Observatory", "Observatory telescope for stars");
  configure(vault, ["embed", "generate", "rerank"]);
  const miss = cli(vault, ["find", "zzzunmatched"], "fake-inference");
  assert.equal(miss.status, 0); assert.deepEqual(miss.data.matches, []);
  assert.deepEqual(ops(miss.calls), ["createStore", "search"], "A fast miss performs no expansion, rerank or second query");
  assert.equal(miss.calls[1]?.request?.rerank, false);
  const question = "Which instrument observes stars?";
  const deep = cli(vault, ["find", "--deep", question, "--terms", "observatory"], "fake-inference");
  assert.equal(deep.status, 0, JSON.stringify(deep));
  assert.deepEqual(ops(deep.calls), ["createStore", "expandQuery", "search"]);
  assert.equal(deep.calls[1]?.query, question);
  assert.deepEqual(deep.calls[2]?.request?.queries, [{ type: "lex", query: "observatory" }, { type: "lex", query: "telescope" }, { type: "vec", query: question }]);
  assert.equal(deep.calls[2]?.request?.rerank, true);
  assert.equal(deep.data.mode, "deep"); assert.equal(deep.data.rerank, true);
  assert.deepEqual(deep.data.matches.map((m: { path: string }) => m.path), [star]);
});

// B12 (okf:12) replaced find's former exit 7 here with labelled degraded lexical retrieval; explicit embedding keeps exit 7.
test("okf:11 okf:12 missing, remote or invalid models are explicit readiness diagnostics without downloads; find degrades to model-free lexical", () => {
  const vault = fresh(), star = note(vault, "Observatory", "Observatory telescope");
  const embed = cli(vault, ["search", "sync", "--embed"], "fake-inference");
  assert.equal(embed.status, 7, JSON.stringify(embed)); assert.equal(embed.data.error.code, "unavailable"); assert.equal(embed.data.readiness, "unavailable");
  assert.ok(embed.data.diagnostics.some((d: { path: string }) => d.path === ".wiki/config.json#search.models.embed"), JSON.stringify(embed.data));
  assert.equal(embed.calls.length + embed.textStore, 0, "No SDK store opened");
  assert.equal(fs.existsSync(path.join(vault, ".wiki/search")), false, "Embedding readiness failure precedes index effects");
  const degraded = (args: string[], roles: string[]) => {
    const result = cli(vault, args, "fake-inference");
    assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.data.ok, true);
    assert.equal(result.data.degraded.retrieval, "lexical"); assert.equal(result.data.degraded.exhaustive, false); assert.equal(result.data.degraded.reason, "models-unavailable");
    assert.deepEqual(result.data.degraded.diagnostics.map((d: { path: string }) => d.path).sort(), roles.map(r => ".wiki/config.json#search.models." + r));
    assert.deepEqual(result.data.embeddingCoverage, { state: "unavailable" }); assert.equal(result.data.rerank, false);
    // Only model-free stores: no expansion, search inference or embedding, and no model configured.
    assert.deepEqual(ops(result.calls), ["createStore"]); assert.equal(result.calls[0]?.models, null);
    return result;
  };
  for (const args of [["find", "telescope"], ["find", "--deep", "telescope"]]) assert.deepEqual(degraded(args, ["embed", ...(args[1] === "--deep" ? ["generate", "rerank"] : [])]).data.matches.map((m: { path: string }) => m.path), [star]);
  configure(vault, ["embed"]);
  degraded(["find", "--deep", "telescope"], ["generate", "rerank"]);
  const config = path.join(vault, ".wiki/config.json"), base = JSON.parse(fs.readFileSync(config, "utf8"));
  const notGguf = path.join(temp, "not-a-model.bin"); fs.writeFileSync(notGguf, "text");
  for (const embed of ["hf:ggml-org/embeddinggemma-300M-GGUF/model.gguf", "https://example.invalid/model.gguf", "relative/model.gguf", path.join(temp, "missing.gguf"), notGguf]) {
    fs.writeFileSync(config, JSON.stringify({ ...base, search: { models: { embed } } }));
    degraded(["find", "telescope"], ["embed"]);
    assert.equal(cli(vault, ["search", "sync", "--embed"]).status, 7, embed);
  }
  const human = cli(vault, ["find", "zzzunmatched"], "", false); assert.equal(human.status, 0);
  assert.match(human.stdout, /degraded: lexical only \(search models not ready\); a miss is not an exhaustive absence claim/); assert.match(human.stdout, /not exhaustive/);
  const humanEmbed = cli(vault, ["search", "sync", "--embed"], "", false); assert.equal(humanEmbed.status, 7); assert.match(humanEmbed.stderr, /^unavailable: Search models are not ready/);
});

test("okf:11 search sync --embed runs explicit embedding synchronously and reports failure or remaining pending coverage", () => {
  const vault = fresh(); note(vault, "Observatory", "Observatory telescope");
  const models = configure(vault, ["embed"]);
  const failed = cli(vault, ["search", "sync", "--embed"], "fake-inference", true, { OKF_QMD_FAKE_EMBED: "fail" });
  assert.equal(failed.status, 7, JSON.stringify(failed)); assert.equal(failed.data.embedding, "failed");
  assert.equal(failed.data.textCoverage.state, "complete"); assert.equal(failed.data.embeddingCoverage.state, "unavailable");
  assert.match(JSON.stringify(failed.data.diagnostics), /Injected local embedding failure/);
  assert.deepEqual(ops(failed.calls), ["createStore", "embed"]); assert.deepEqual(failed.calls[0]?.models, models);
  // A reported embed completion is not trusted: remaining pending hashes fail closed.
  const pending = cli(vault, ["search", "sync", "--embed"], "fake-inference");
  assert.equal(pending.status, 7); assert.deepEqual(pending.data.embeddingCoverage, { state: "incomplete", contentHashes: 1 });
  assert.equal(fs.existsSync(path.join(vault, ".wiki/search/writer.lock")), false);
  const plain = cli(vault, ["search", "sync"], "fake-inference"); assert.equal(plain.status, 0); assert.equal(plain.textStore, 2); assert.deepEqual(plain.textModels, models); assert.deepEqual(ops(plain.calls), [], "Plain sync opens no model-configured store");
});

test("okf:11 find option boundaries are usage errors before index effects", () => {
  const vault = fresh(); note(vault, "Observatory", "Observatory telescope");
  for (const args of [["find"], ["find", "a", "b"], ["find", " "], ["find", "a", "--terms", " "], ["search", "sync", "--deep"], ["search", "sync", "--terms", "x"], ["find", "a", "--embed"], ["show", "x", "--deep"]]) {
    const result = cli(vault, args); assert.equal(result.status, 2, JSON.stringify(args) + JSON.stringify(result.data)); assert.equal(result.data.error.code, "usage");
  }
  assert.equal(fs.existsSync(path.join(vault, ".wiki/search")), false);
});

test("okf:11 SIGTERM during explicit embedding, expansion or search is never reported as success and releases the index lock", () => {
  const vault = fresh(); note(vault, "Observatory", "Observatory telescope for stars");
  configure(vault, ["embed", "generate", "rerank"]);
  for (const [seam, args] of [["embed", ["search", "sync", "--embed"]], ["search", ["find", "telescope"]], ["expand", ["find", "--deep", "telescope"]], ["search", ["find", "--deep", "telescope stars"]]] as const) {
    // B12: deep search needs a usable expansion entry; the fake's lex "telescope" equals a bare "telescope" question, which now degrades before search.
    const result = cli(vault, [...args], "fake-inference-interrupt-" + seam);
    assert.equal(result.status, 7, seam + JSON.stringify(result.data)); assert.equal(result.data.ok, false); assert.equal(result.data.error.code, "unavailable");
    assert.ok(result.calls.some(c => c.op === (seam === "expand" ? "expandQuery" : seam)), "The interrupt fired at the inference seam");
    assert.notEqual(result.data.embedding, "complete"); assert.equal(result.data.matches, undefined);
    assert.match(JSON.stringify(result.data.diagnostics), /interrupted/);
    assert.equal(fs.existsSync(path.join(vault, ".wiki/search/writer.lock")), false);
  }
});

test("okf:11 a writer taking the index lock between text sync and find/embed is conflict exit 3, not unavailable", () => {
  const vault = fresh(); note(vault, "Observatory", "Observatory telescope");
  configure(vault, ["embed"]);
  for (const args of [["find", "telescope"], ["search", "sync", "--embed"]]) {
    const lock = path.join(vault, ".wiki/search/writer.lock"); fs.rmSync(lock, { force: true });
    const result = cli(vault, args, "fake-inference-steal-lock");
    assert.equal(result.status, 3, JSON.stringify(result.data)); assert.equal(result.data.error.code, "conflict");
    assert.equal(result.data.textCoverage.state, "complete", "Text sync finished before the other writer arrived");
    assert.equal(fs.readFileSync(lock, "utf8"), "other writer", "The other writer's lock is never removed");
    const human = cli(vault, args, "fake-inference-steal-lock", false); assert.equal(human.status, 3); assert.match(human.stderr, /^conflict:/);
    fs.rmSync(lock);
  }
});

test("okf:11 SDK model cache binds to vault-local derived state, never an absent or unwritable user cache", () => {
  const vault = fresh(); note(vault, "Observatory", "Observatory telescope");
  configure(vault, ["embed", "generate", "rerank"]);
  const decoy = path.join(temp, "decoy-" + counter); fs.mkdirSync(decoy); fs.chmodSync(decoy, 0o500);
  const env = { HOME: path.join(decoy, "home"), XDG_CACHE_HOME: path.join(decoy, "cache"), XDG_CONFIG_HOME: path.join(decoy, "config"), XDG_DATA_HOME: path.join(decoy, "data") };
  try {
    for (const args of [["search", "sync", "--embed"], ["find", "telescope"], ["find", "--deep", "telescope"]]) {
      const result = cli(vault, args, "fake-inference", true, env);
      assert.ok(result.status === 0 || args[2] === "--embed" && result.status === 7, JSON.stringify(result.data));
      assert.doesNotMatch(JSON.stringify(result.data.diagnostics), /EACCES|decoy/);
      for (const call of result.calls.filter(c => c.op === "createStore")) assert.equal((call as { modelCacheDir?: string }).modelCacheDir, path.join(fs.realpathSync(vault), ".wiki/search/sdk-cache/qmd/models"));
      assert.deepEqual(fs.readdirSync(decoy), [], "No cache, config or data under the decoy home");
    }
    assert.equal(fs.statSync(path.join(vault, ".wiki/search/sdk-cache/qmd/models")).isDirectory(), true);
  } finally { fs.chmodSync(decoy, 0o700); }
});

test("okf:11 nested SDK cache symlinks or non-directories are refused before SDK effects and leave external directories unchanged", () => {
  for (const [label, linked] of [["nested qmd", "sdk-cache/qmd"], ["final models", "sdk-cache/qmd/models"], ["config qmd", "sdk-config/qmd"]] as const) {
    const vault = fresh(); note(vault, "Observatory", "Observatory telescope"); configure(vault, ["embed"]);
    const external = fs.mkdtempSync(path.join(temp, "external-")); fs.writeFileSync(path.join(external, "keep.txt"), "external bytes");
    const link = path.join(vault, ".wiki/search", linked);
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(external, link);
    for (const args of [["search", "sync", "--embed"], ["find", "telescope"]]) {
      const result = cli(vault, args, "fake-inference");
      assert.equal(result.status, 7, label + JSON.stringify(result.data)); assert.equal(result.data.error.code, "unavailable");
      assert.match(JSON.stringify(result.data.diagnostics), /Refusing symlinked target or ancestor/, label);
      assert.equal(result.calls.length, 0, "No SDK store opened");
      assert.deepEqual(fs.readdirSync(external), ["keep.txt"], label + ": external listing unchanged");
      assert.equal(fs.readFileSync(path.join(external, "keep.txt"), "utf8"), "external bytes");
    }
  }
  const vault = fresh(); note(vault, "Observatory", "Observatory telescope"); configure(vault, ["embed"]);
  fs.mkdirSync(path.join(vault, ".wiki/search/sdk-cache/qmd"), { recursive: true }); fs.writeFileSync(path.join(vault, ".wiki/search/sdk-cache/qmd/models"), "not a directory");
  const result = cli(vault, ["find", "telescope"], "fake-inference");
  assert.equal(result.status, 7); assert.match(JSON.stringify(result.data.diagnostics), /Expected a directory/);
});
