import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// B12: real CLI processes over real QMD storage. Only inference is faked
// (qmd-fake-inference.js: expansion, vector/rerank search, document embedding).
const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const GUARD = fileURLToPath(new URL("./qmd-cli-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-qmd-current-"));
after(() => {
  try {
    for (const dir of ["cache", "config", "data"]) assert.equal(fs.existsSync(path.join(temp, dir)), false, "No global-default search state: " + dir);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
let counter = 0;
type Match = { path: string; score: number; digest: string; title: string; description: string; excerpt: string };
function cli(vault: string, args: string[], mode = "fake-inference", extraEnv: Record<string, string> = {}, json = true) {
  const log = vault + ".calls.jsonl";
  fs.rmSync(log, { force: true });
  const result = spawnSync(process.execPath, ["--import", GUARD, BIN, "--vault", vault, ...(json ? ["--json"] : []), ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, HOME: temp, XDG_CACHE_HOME: path.join(temp, "cache"), XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"), WIKI_VAULT: "", QMD_EMBED_MODEL: "", OKF_QMD_CLI_GUARD: mode, OKF_QMD_CALL_LOG: log, OKF_QMD_DENY_SUBPROCESS: "1", ...extraEnv },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  if (json) assert.equal(result.stderr, "");
  const calls: { op: string }[] = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { status: result.status, data: json ? JSON.parse(result.stdout) : undefined, stdout: result.stdout, stderr: result.stderr, ops: calls.map(c => c.op) };
}
function succeeds(vault: string, args: string[], mode = "fake-inference", extraEnv: Record<string, string> = {}) {
  const result = cli(vault, args, mode, extraEnv); assert.equal(result.status, 0, JSON.stringify(result)); return result;
}
function fresh() {
  const vault = path.join(temp, String(++counter)); succeeds(vault, ["init"], "");
  const file = path.join(temp, "model-" + counter + ".gguf"); fs.writeFileSync(file, "GGUF placeholder");
  const config = path.join(vault, ".wiki/config.json");
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), search: { models: { embed: file, generate: file, rerank: file } } }, null, 2) + "\n");
  return vault;
}
function note(vault: string, title: string, description: string, line: string) {
  const relative = succeeds(vault, ["new", "note", "--personal", "--title", title, "--description", description], "").data.path as string;
  fs.appendFileSync(path.join(vault, relative), "\n" + line + "\n");
  return relative;
}
const sha = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const current = (vault: string, relative: string) => sha(fs.readFileSync(path.join(vault, relative)));
const paths = (matches: Match[]) => matches.map(m => m.path).sort();

test("okf:12 add, equal-size restored-mtime edit, rename and delete between finds render only current revisions", () => {
  const vault = fresh(), star = note(vault, "Observatory", "Observatory telescope", "Violet photon detector");
  const file = path.join(vault, star), time = new Date("2026-01-01T00:00:00Z"); fs.utimesSync(file, time, time);
  let found = succeeds(vault, ["find", "photon"]).data;
  assert.deepEqual(found.matches, [{ path: star, score: found.matches[0].score, digest: current(vault, star), title: "Observatory", description: "Observatory telescope", excerpt: "Violet photon detector" }]);
  // Equal size and restored mtime: only content comparison can see this edit.
  const before = fs.statSync(file), edited = fs.readFileSync(file, "utf8").replace("Violet", "Yellow");
  fs.writeFileSync(file, edited); fs.utimesSync(file, time, time);
  assert.equal(fs.statSync(file).size, before.size); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  const garden = note(vault, "Garden", "Garden soil", "Photon greenhouse lamp");
  found = succeeds(vault, ["find", "photon"]).data;
  assert.deepEqual(paths(found.matches), [garden, star].sort());
  const starMatch = found.matches.find((m: Match) => m.path === star);
  assert.equal(starMatch.excerpt, "Yellow photon detector", "Excerpt comes from the current revision, not the old indexed text");
  assert.equal(starMatch.digest, sha(edited)); assert.equal(found.textCoverage.state, "complete");
  assert.deepEqual(succeeds(vault, ["find", "violet"]).data.matches, [], "The old revision's text no longer matches");
  const renamed = "personal/notes/renamed.md"; fs.renameSync(file, path.join(vault, renamed));
  fs.unlinkSync(path.join(vault, garden));
  found = succeeds(vault, ["find", "photon"]).data;
  assert.deepEqual(paths(found.matches), [renamed], "Deleted and old renamed paths are never emitted");
  assert.equal(found.matches[0].digest, sha(edited)); assert.equal(found.matches[0].excerpt, "Yellow photon detector");
  assert.deepEqual(found.textCoverage.inventory.map((n: { path: string }) => n.path), [renamed]);
  assert.equal(fs.readFileSync(path.join(vault, renamed), "utf8"), edited, "Search preserves current file bytes");
  const human = cli(vault, ["find", "photon"], "fake-inference", {}, false);
  assert.equal(human.status, 0); assert.match(human.stdout, new RegExp(renamed + " \\S+ " + sha(edited) + "\\n  Observatory: Observatory telescope\\n  Yellow photon detector"));
});

for (const kind of ["edit", "delete"] as const) test("okf:12 a note that " + (kind === "edit" ? "changes" : "disappears") + " during search is omitted with a moving-target diagnostic and incomplete text coverage", () => {
  const vault = fresh(), moving = note(vault, "Observatory", "Observatory telescope", "Photon detector"), stable = note(vault, "Garden", "Garden soil", "Photon lamp");
  const result = succeeds(vault, ["find", "photon"], "fake-inference-move-" + kind, { OKF_QMD_MOVE_PATH: path.join(vault, moving) });
  assert.ok(result.ops.includes("search"), "The change happened at the search inference seam");
  assert.deepEqual(paths(result.data.matches), [stable]); assert.equal(result.data.matches[0].digest, current(vault, stable));
  assert.equal(result.data.textCoverage.state, "incomplete");
  const diagnostic = result.data.diagnostics.find((d: { path: string }) => d.path === moving);
  assert.match(diagnostic?.message ?? "", /moving target/, JSON.stringify(result.data));
  assert.deepEqual(result.data.textCoverage.diagnostics, result.data.diagnostics);
  assert.equal(result.ops.filter(op => op === "search").length, 1, "A moving target is not retried");
  // The next search captures the current revision again.
  const next = succeeds(vault, ["find", "photon"]).data;
  assert.equal(next.textCoverage.state, "complete");
  assert.deepEqual(paths(next.matches), kind === "edit" ? [moving, stable].sort() : [stable]);
});

test("okf:12 vector failure returns labelled degraded lexical matches; a degraded miss is not exhaustive", () => {
  const vault = fresh(), star = note(vault, "Observatory", "Observatory telescope", "Photon detector");
  const env = { OKF_QMD_FAKE_VECTOR: "fail" };
  for (const args of [["find", "photon"], ["find", "--deep", "Which detector?", "--terms", "photon"]]) {
    const result = succeeds(vault, args, "fake-inference", env);
    assert.equal(result.data.ok, true); assert.equal(result.data.mode, args[1] === "--deep" ? "deep" : "fast");
    assert.equal(result.data.degraded.retrieval, "lexical"); assert.equal(result.data.degraded.exhaustive, false); assert.equal(result.data.degraded.reason, "vector-failed");
    assert.match(JSON.stringify(result.data.degraded.diagnostics), /Injected local vector inference failure/);
    assert.deepEqual(result.data.queries, [{ type: "lex", query: "photon" }]); assert.equal(result.data.rerank, false);
    assert.deepEqual(result.data.embeddingCoverage, { state: "unavailable" }, "Vectors covered nothing for this request");
    assert.equal(result.data.textCoverage.state, "complete");
    assert.deepEqual(result.data.matches.map((m: Match) => [m.path, m.digest, m.excerpt]), [[star, current(vault, star), "Photon detector"]]);
    assert.equal(result.ops.includes("embed"), false, "Find never embeds");
  }
  const miss = succeeds(vault, ["find", "zzzunmatched"], "fake-inference", env);
  assert.deepEqual(miss.data.matches, []); assert.equal(miss.data.degraded.exhaustive, false);
  const human = cli(vault, ["find", "zzzunmatched"], "fake-inference", env, false);
  assert.equal(human.status, 0); assert.match(human.stdout, /degraded: lexical only \(vector search failed\)/); assert.match(human.stdout, /No degraded lexical matches \(not exhaustive\)/);
  assert.match(human.stdout, /Embedding coverage: unavailable/);
});

test("okf:12 incomplete or failed synchronization never reports complete text coverage; unusable search exits 7", () => {
  const vault = fresh(), good = note(vault, "Observatory", "Observatory telescope", "Photon detector"), broken = note(vault, "Garden", "Garden soil", "Photon lamp");
  fs.writeFileSync(path.join(vault, broken), fs.readFileSync(path.join(vault, broken), "utf8").replace(/description:.*\n/, ""));
  const partial = succeeds(vault, ["find", "photon"]).data;
  assert.equal(partial.textCoverage.state, "incomplete"); assert.ok(partial.diagnostics.some((d: { path: string }) => d.path === broken));
  assert.deepEqual(paths(partial.matches), [good], "Invalid notes are never emitted as current results");
  for (const mode of ["missing-sdk", "missing-native"]) {
    const failed = cli(vault, ["find", "photon"], mode);
    assert.equal(failed.status, 7, JSON.stringify(failed.data)); assert.equal(failed.data.error.code, "unavailable");
    assert.equal(failed.data.textCoverage.state, "unavailable"); assert.equal(failed.data.embeddingCoverage.state, "unavailable"); assert.equal(failed.data.matches, undefined);
  }
});
