import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { spawnCli } from "./cli-helper.ts";
import { fileURLToPath } from "node:url";

// Real CLI processes over real QMD storage. Only external inference is faked
// (qmd-fake-inference.js: the fake vector half contributes nothing, so lexical misses stay misses).
const GUARD = fileURLToPath(new URL("./qmd-cli-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-qmd-literal-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
type Match = { path: string; scope: string; type: string; score: number | null; literal: string[]; digest: string; title: string; description: string; excerpt: string };
function cli(vault: string, args: string[], mode = "fake-inference", extraEnv: Record<string, string> = {}, json = true) {
  const log = vault + ".calls.jsonl";
  fs.rmSync(log, { force: true });
  const result = spawnCli(["--vault", vault, ...(json ? ["--json"] : []), ...args], {
    imports: [GUARD], timeout: 30000,
    env: { ...process.env, HOME: temp, XDG_CACHE_HOME: path.join(temp, "cache"), XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"), WIKI_VAULT: "", QMD_EMBED_MODEL: "", WIKI_QMD_CLI_GUARD: mode, WIKI_QMD_CALL_LOG: log, WIKI_QMD_DENY_SUBPROCESS: "1", ...extraEnv },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  if (json) assert.equal(result.stderr, "");
  const ops = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).op as string) : [];
  return { status: result.status, data: json ? JSON.parse(result.stdout) : undefined, stdout: result.stdout, stderr: result.stderr, ops };
}
function succeeds(vault: string, args: string[], mode = "fake-inference", extraEnv: Record<string, string> = {}) {
  const result = cli(vault, args, mode, extraEnv); assert.equal(result.status, 0, JSON.stringify(result)); return result;
}
function fresh(models = true) {
  const vault = path.join(temp, String(++counter)); succeeds(vault, ["init"], "");
  if (models) {
    // Placeholder GGUF file: a valid local path for readiness; never loaded because inference is faked.
    const file = path.join(temp, "model-" + counter + ".gguf"); fs.writeFileSync(file, "GGUF placeholder");
    const config = path.join(vault, ".wiki/config.json");
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), search: { models: { embed: file } } }, null, 2) + "\n");
  }
  return vault;
}
function note(vault: string, title: string, body: string, scope: string[] = ["--personal"], type = "note") {
  const file = path.join(temp, "body-" + (++counter) + ".md"); fs.writeFileSync(file, body);
  return succeeds(vault, ["new", type, ...scope, "--title", title, "--description", title + " description", "--body-file", file], "").data.path as string;
}
const paths = (matches: Match[]) => matches.map(m => m.path);
const sha = (vault: string, relative: string) => "sha256:" + createHash("sha256").update(fs.readFileSync(path.join(vault, relative))).digest("hex");

test("wiki:13 a note mentioning a slash path or dotted filename is found when qmd misses it, without opening the mentioned path", () => {
  for (const models of [true, false]) {
    const vault = fresh(models);
    const handler = note(vault, "Request routing", "Routing lives in `src/server/handler.ts` today.\n");
    const env = note(vault, "Secrets", "Never commit the .env.production file.\n");
    note(vault, "Garden", "Garden tomatoes in soil\n");
    // The repository file exists outside the vault; search must not open it.
    const forbid = { WIKI_QMD_FORBID_PATH: "src/server/handler.ts" };
    const found = succeeds(vault, ["find", "where is src/server/handler.ts?", "--terms", "zzzunmatched"], "fake-inference", forbid).data;
    assert.deepEqual(paths(found.matches), [handler], JSON.stringify(found));
    assert.deepEqual(found.literals, ["src/server/handler.ts"]);
    assert.equal(found.matches[0].score, null, "qmd did not return it; only the literal match did");
    assert.deepEqual(found.matches[0].literal, ["src/server/handler.ts"]);
    assert.equal(found.matches[0].excerpt, "Routing lives in `src/server/handler.ts` today.", "The excerpt is the line holding the literal token");
    assert.equal(found.matches[0].digest, sha(vault, handler)); assert.equal(found.matches[0].description, "Request routing description");
    assert.equal(found.textCoverage.state, "complete");
    if (!models) assert.equal(found.degraded.reason, "models-unavailable", "Literal matching also serves the degraded lexical mode");
    const dotted = succeeds(vault, ["find", "which file holds .env.production", "--terms", "zzzunmatched"]).data;
    assert.deepEqual(paths(dotted.matches), [env]); assert.deepEqual(dotted.literals, [".env.production"]);
    // Canonical paths match too: the note's own path is a literal token.
    assert.deepEqual(paths(succeeds(vault, ["find", "notes/garden.md", "--terms", "zzzunmatched"]).data.matches), ["personal/notes/garden.md"]);
    assert.deepEqual(succeeds(vault, ["find", "version v1.2 of zzzunmatched"]).data.literals, [], "A version number is not a dotted filename");
  }
});

test("wiki:13 dotted filenames with numeric or punctuation extensions are literal tokens; version strings are not", () => {
  const vault = fresh(false);
  const man = note(vault, "Manual page", "Read printf.3 for format details.\n");
  const lib = note(vault, "Library", "Link against libssl.so.3 at runtime.\n");
  const cpp = note(vault, "Cpp", "The entry point is main.c++ in the root.\n");
  note(vault, "Release", "Shipped version v1.2 last week.\n");
  for (const [token, expected] of [["printf.3", man], ["libssl.so.3", lib], ["main.c++", cpp]] as const) {
    const found = succeeds(vault, ["find", token, "--terms", "zzzunmatched"]).data;
    assert.equal(found.degraded.reason, "models-unavailable");
    assert.deepEqual(found.literals, [token]); assert.deepEqual(paths(found.matches), [expected], token);
    assert.equal(found.matches[0].score, null, "Found by literal match only");
  }
  for (const version of ["v1.2", "1.2.3", "v2.0.1-beta"]) {
    const found = succeeds(vault, ["find", version, "--terms", "zzzunmatched"]).data;
    assert.deepEqual(found.literals, [], version + " is a version, not a filename"); assert.deepEqual(found.matches, []);
  }
});

test("wiki:13 every match carries its scope and registered type from the captured revision", () => {
  const vault = fresh();
  succeeds(vault, ["type", "add", "building", "--folder", "build"], "");
  const custom = note(vault, "Hangar", "Hangar plan in docs/hangar.md.\n", ["--project", "site"], "building");
  const personal = note(vault, "Hangar notes", "Hangar notes.\n");
  const found = succeeds(vault, ["find", "where is docs/hangar.md", "--terms", "hangar"]).data;
  const byPath = new Map((found.matches as Match[]).map(m => [m.path, m]));
  assert.equal(custom, "projects/site/build/hangar.md");
  assert.deepEqual([byPath.get(custom)?.scope, byPath.get(custom)?.type], ["projects/site", "building"], "Literal match metadata");
  assert.deepEqual([byPath.get(personal)?.scope, byPath.get(personal)?.type], ["personal", "note"], "qmd match metadata");
  assert.equal(byPath.get(personal)?.literal.length, 0);
});

test("wiki:13 tokens match literally, never as regex, shell or FTS syntax", () => {
  const vault = fresh();
  const glob = note(vault, "Glob", "Pattern lib/[ab]*.ts selects files.\n");
  note(vault, "Plain", "See lib/a.ts and lib/b.ts directly.\n");
  const shell = note(vault, "Shell", "Run bin/$(whoami).sh carefully.\n");
  note(vault, "Fts", "Plain words NEAR other words.\n");
  const fts = note(vault, "Fts syntax", "Column filter title:*/OR.md is literal.\n");
  assert.deepEqual(paths(succeeds(vault, ["find", "lib/[ab]*.ts", "--terms", "zzzunmatched"]).data.matches), [glob], "A regex or glob reading would match lib/a.ts");
  assert.deepEqual(paths(succeeds(vault, ["find", "bin/$(whoami).sh", "--terms", "zzzunmatched"]).data.matches), [shell], "No shell expansion");
  assert.deepEqual(paths(succeeds(vault, ["find", "title:*/OR.md", "--terms", "zzzunmatched"]).data.matches), [fts], "No FTS operator reading");
  // Case is part of the literal text.
  assert.deepEqual(succeeds(vault, ["find", "LIB/[AB]*.TS", "--terms", "zzzunmatched"]).data.matches, []);
});

test("wiki:13 literal matches precede qmd candidates, collapse by canonical path, and qmd order is kept with canonical tie breaks", () => {
  const vault = fresh();
  const both = note(vault, "Both", "Telescope notes for docs/x.md here.\n");
  const literalOnly = note(vault, "Literal", "Only docs/x.md is mentioned.\n");
  const strong = note(vault, "Strong", "Telescope telescope telescope telescope.\n");
  const weak = note(vault, "Weak", "A telescope appears once in this rather long sentence about other things entirely.\n");
  // Identical text in two scopes: equal qmd scores, ordered by canonical path.
  const tiedProject = note(vault, "Tied", "Telescope pair.\n", ["--project", "alpha"]);
  const tiedPersonal = note(vault, "Tied", "Telescope pair.\n");
  const found = succeeds(vault, ["find", "about docs/x.md", "--terms", "telescope"]).data;
  const matches: Match[] = found.matches;
  assert.equal(new Set(paths(matches)).size, matches.length, "One entry per canonical path");
  assert.deepEqual(paths(matches).slice(0, 2), [both, literalOnly], "Literal matches first; among them qmd rank, then path");
  assert.deepEqual(matches[0]?.literal, ["docs/x.md"]); assert.equal(typeof matches[0]?.score, "number", "A literal match qmd also found keeps its qmd score");
  const qmdPart = matches.slice(2);
  assert.deepEqual(new Set(paths(qmdPart)), new Set([strong, weak, tiedProject, tiedPersonal]));
  for (const [i, m] of qmdPart.entries()) if (i) {
    const prev = qmdPart[i - 1]!;
    assert.ok(prev.score! > m.score! || prev.score === m.score && prev.path < m.path, "qmd score order with canonical tie breaks: " + JSON.stringify(qmdPart.map(q => [q.path, q.score])));
  }
  const tied = qmdPart.filter(m => m.path === tiedPersonal || m.path === tiedProject);
  assert.equal(tied[0]!.score, tied[1]!.score, "The tied fixture has equal qmd scores");
  assert.deepEqual(paths(tied), [tiedPersonal, tiedProject]);
  // Deterministic: the same request returns the same order.
  assert.deepEqual(paths(succeeds(vault, ["find", "about docs/x.md", "--terms", "telescope"]).data.matches), paths(matches));
  const human = cli(vault, ["find", "about docs/x.md", "--terms", "telescope"], "fake-inference", {}, false);
  assert.equal(human.status, 0);
  assert.match(human.stdout, new RegExp(literalOnly + " literal " + sha(vault, literalOnly) + " \\[literal: docs/x\\.md\\]\\n  Literal: Literal description\\n  Only docs/x\\.md is mentioned\\."));
});

test("wiki:13 scope and type filters apply before the final limit; the default limit is the pinned qmd default", () => {
  const vault = fresh();
  for (let i = 0; i < 12; i++) note(vault, "Personal " + String.fromCharCode(97 + i), "Comet comet comet sighting " + i + ".\n");
  const project = note(vault, "Project comet", "One comet mention buried in a long sentence about many unrelated topics and words.\n", ["--project", "demo"]);
  const reference = note(vault, "Comet reference", "Comet catalogue.\n", ["--personal"], "reference");
  const all = succeeds(vault, ["find", "comet"]).data;
  assert.equal(all.limit, 10); assert.equal(all.matches.length, 10, "Omitted --limit uses the qmd SDK documented default of 10");
  assert.equal(paths(all.matches).includes(project), false, "The weak project note ranks below the default limit");
  const scoped = succeeds(vault, ["find", "comet", "--project", "demo", "--limit", "1"]).data;
  assert.deepEqual(paths(scoped.matches), [project], "The scope filter runs before the limit"); assert.deepEqual(scoped.filters, { scope: "projects/demo" });
  const personal = succeeds(vault, ["find", "comet", "--personal", "--limit", "20"]).data;
  assert.equal(personal.matches.length, 13); assert.ok(paths(personal.matches).every(p => p.startsWith("personal/")));
  assert.deepEqual(paths(succeeds(vault, ["find", "comet", "--type", "reference", "--limit", "1"]).data.matches), [reference], "The type filter runs before the limit");
  assert.deepEqual(succeeds(vault, ["find", "comet", "--type", "reference", "--project", "demo"]).data.matches, []);
  const two = succeeds(vault, ["find", "comet", "--limit", "2"]).data;
  assert.deepEqual(paths(two.matches), paths(all.matches).slice(0, 2));
  assert.equal(succeeds(vault, ["find", "comet", "--limit", "100"]).data.matches.length, 14, "No hidden cap below the caller's limit");
  for (const args of [["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "abc"], ["--limit", "99999999999999999999"], ["--type", "unknown-type"], ["--type", "../x"], ["--project", "demo", "--personal"], ["--project", "Bad/Name"]]) {
    const bad = cli(vault, ["find", "comet", ...args]);
    assert.equal(bad.status, 2, args.join(" ") + JSON.stringify(bad.data)); assert.equal(bad.data.error.code, "usage");
  }
  for (const args of [["lint", "--limit", "1"], ["search", "sync", "--type", "note"]]) assert.equal(cli(vault, args).status, 2);
});

test("wiki:13 a literal-only match that changes during search is omitted with a moving-target diagnostic", () => {
  const vault = fresh();
  const moving = note(vault, "Moving", "Mentions src/app.ts once.\n"), stable = note(vault, "Stable", "Also src/app.ts here.\n");
  const result = succeeds(vault, ["find", "src/app.ts", "--terms", "zzzunmatched"], "fake-inference-move-edit", { WIKI_QMD_MOVE_PATH: path.join(vault, moving) });
  assert.ok(result.ops.includes("search"), "The edit happened at the search inference seam");
  assert.deepEqual(paths(result.data.matches), [stable]); assert.equal(result.data.matches[0].digest, sha(vault, stable));
  assert.equal(result.data.textCoverage.state, "incomplete");
  assert.match(result.data.diagnostics.find((d: { path: string }) => d.path === moving)?.message ?? "", /moving target/);
  assert.deepEqual(paths(succeeds(vault, ["find", "src/app.ts", "--terms", "zzzunmatched"]).data.matches), [moving, stable], "The next search captures the current revision");
});
