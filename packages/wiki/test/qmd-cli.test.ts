import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, spawnCli } from "./cli-helper.ts";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { searchQmdLex } from "../src/qmd.ts";

const GUARD = fileURLToPath(new URL("./qmd-cli-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-qmd-cli-"));
process.env.HOME = temp;
process.env.XDG_CACHE_HOME = path.join(temp, "cache");
process.env.XDG_CONFIG_HOME = path.join(temp, "config");
process.env.XDG_DATA_HOME = path.join(temp, "data");
after(() => {
  try {
    for (const dir of ["cache", "config", "data"]) assert.equal(fs.existsSync(path.join(temp, dir)), false, "No global-default search state: " + dir);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
let counter = 0;
function digest(bytes: string) { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
/** Complete text coverage per the README JSON contract: count plus the digest of the path-sorted inventory. */
function complete(entries: { path: string; digest: string }[]) {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { state: "complete", inventoryCount: sorted.length, inventoryDigest: digest(JSON.stringify(sorted)) };
}
function cli(vault: string, args: string[], mode = "", json = true) {
  const result = spawnCli(["--vault", vault, ...(json ? ["--json"] : []), ...args], {
    imports: [GUARD], timeout: 15000,
    env: { ...process.env, HOME: temp, XDG_CACHE_HOME: path.join(temp, "cache"), XDG_CONFIG_HOME: path.join(temp, "config"), WIKI_VAULT: "", WIKI_QMD_CLI_GUARD: mode },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  if (json) assert.equal(result.stderr, "");
  return { status: result.status, data: json ? JSON.parse(result.stdout) : undefined, stdout: result.stdout, stderr: result.stderr };
}
function succeeds(vault: string, args: string[]) { const result = cli(vault, args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data; }
function fresh() { const vault = path.join(temp, String(++counter)); succeeds(vault, ["init"]); return vault; }
function note(vault: string, title = "Observatory", scope = ["--personal"]) {
  return succeeds(vault, ["new", "note", ...scope, "--title", title, "--description", title + " telescope"]).path as string;
}
function read(vault: string, relative: string) { return fs.readFileSync(path.join(vault, relative), "utf8"); }
function receipt(vault: string) { return path.join(vault, ".wiki/search/coverage.json"); }

test("wiki:10 in-process search sync gives the SDK run()'s env and leaves the host environment unchanged", async () => {
  const vault = fresh(); note(vault);
  // Source event: QMD 2.8.3 openDatabase turns process.env.QMD_SQLITE_BUSY_TIMEOUT into this PRAGMA (default 120000).
  const Database = createRequire(import.meta.url)("better-sqlite3") as { prototype: { exec(this: unknown, sql: string): unknown } };
  const exec = Database.prototype.exec;
  const seen: { sql: string; cache: string | undefined }[] = [];
  Database.prototype.exec = function (sql) {
    if (sql.startsWith("PRAGMA busy_timeout")) seen.push({ sql, cache: process.env.XDG_CACHE_HOME });
    return exec.call(this, sql);
  };
  assert.equal(process.env.QMD_SQLITE_BUSY_TIMEOUT, undefined);
  const host = { ...process.env };
  let result;
  try { result = await runCli(["--json", "--vault", vault, "search", "sync"], { env: { ...process.env, QMD_SQLITE_BUSY_TIMEOUT: "4321" } }); }
  finally { Database.prototype.exec = exec; }
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.equal(JSON.parse(result.stdout).ok, true);
  assert.ok(seen.length > 0);
  for (const open of seen) {
    assert.equal(open.sql, "PRAGMA busy_timeout = 4321");
    assert.equal(open.cache, path.join(fs.realpathSync(vault), ".wiki/search/sdk-cache"));
  }
  assert.deepEqual({ ...process.env }, host);
});

// Real CLI processes are the e2e seam. SDK reads independently verify indexed bytes.
test("wiki:10 CLI sync captures registry-valid full Markdown with separate pending embedding coverage and human output", async () => {
  const vault = fresh(), relative = note(vault);
  const bytes = "\uFEFF" + read(vault, relative).replaceAll("\n", "\r\n") + "Quasar trailing spaces  ";
  fs.writeFileSync(path.join(vault, relative), bytes);
  const result = succeeds(vault, ["search", "sync"]);
  assert.equal(result.ok, true); assert.equal(result.coverageBasis, "captured-inventory");
  assert.deepEqual(result.textCoverage, complete([{ path: relative, digest: digest(bytes) }]));
  assert.deepEqual(result.embeddingCoverage, { state: "incomplete", contentHashes: 1 });
  const found = await searchQmdLex(vault, "quasar"); assert.equal(found.state, "successful", JSON.stringify(found));
  assert.equal(found.matches[0]?.markdown, bytes); assert.equal(found.matches[0]?.path, relative);
  const human = cli(vault, ["search", "sync"], "", false);
  assert.equal(human.status, 0); assert.match(human.stdout, /Text coverage: complete/); assert.match(human.stdout, /Embedding coverage: incomplete/); assert.match(human.stdout, /captured inventory/);
  assert.equal(fs.existsSync(path.join(temp, "cache")), false); assert.equal(fs.existsSync(path.join(temp, "config")), false);
});

test("wiki:10 CLI sync tracks equal-size/equal-mtime edits, add, rename, delete and derived rebuild", async () => {
  const vault = fresh(), relative = note(vault);
  const file = path.join(vault, relative), bytes = read(vault, relative) + "Violet photon\n";
  fs.writeFileSync(file, bytes); const time = new Date("2026-01-01"); fs.utimesSync(file, time, time);
  succeeds(vault, ["search", "sync"]);
  const changed = bytes.replace("Violet", "Yellow"); fs.writeFileSync(file, changed); fs.utimesSync(file, time, time);
  const second = note(vault, "Garden");
  let result = succeeds(vault, ["search", "sync"]); assert.deepEqual(result.textCoverage, complete([{ path: relative, digest: digest(changed) }, { path: second, digest: digest(read(vault, second)) }]));
  const renamed = "personal/notes/renamed.md"; fs.renameSync(file, path.join(vault, renamed)); fs.unlinkSync(path.join(vault, second));
  result = succeeds(vault, ["search", "sync"]); assert.deepEqual(result.textCoverage, complete([{ path: renamed, digest: digest(changed) }]));
  let found = await searchQmdLex(vault, "Yellow"); assert.equal(found.state, "successful"); assert.deepEqual(found.matches.map(m => m.path), [renamed]);
  fs.rmSync(path.join(vault, ".wiki/search"), { recursive: true });
  assert.deepEqual(succeeds(vault, ["search", "sync"]).textCoverage, result.textCoverage);
  fs.unlinkSync(path.join(vault, renamed)); assert.deepEqual(succeeds(vault, ["search", "sync"]).textCoverage, complete([]));
  found = await searchQmdLex(vault, "photon"); assert.equal(found.state, "successful"); assert.deepEqual(found.matches, []);
});

test("wiki:10 CLI sync excludes navigation, assets and operations and diagnoses invalid, unknown and unreadable concepts", async () => {
  const vault = fresh(), good = note(vault), invalid = note(vault, "Invalid"), unknown = note(vault, "Unknown"), unreadable = note(vault, "Unreadable");
  succeeds(vault, ["search", "sync"]); assert.equal(fs.existsSync(receipt(vault)), true);
  fs.appendFileSync(path.join(vault, "index.md"), "Operationalneedle\n"); fs.appendFileSync(path.join(vault, "log.md"), "Operationalneedle\n");
  for (const dir of ["personal/assets", ".wiki/tmp", ".obsidian", "node_modules"]) { fs.mkdirSync(path.join(vault, dir), { recursive: true }); fs.writeFileSync(path.join(vault, dir, "hidden.md"), "Operationalneedle"); }
  fs.writeFileSync(path.join(vault, invalid), read(vault, invalid).replace(/description:.*\n/, ""));
  fs.writeFileSync(path.join(vault, unknown), read(vault, unknown).replace(/type:.*\n/, "type: mystery\n"));
  const result = cli(vault, ["search", "sync"], "unreadable"); assert.equal(result.status, 0); assert.equal(result.data.textCoverage.state, "incomplete");
  for (const relative of [invalid, unknown, unreadable]) assert.ok(result.data.diagnostics.some((d: { path: string }) => d.path === relative), JSON.stringify(result.data));
  assert.equal(fs.existsSync(receipt(vault)), false);
  const found = await searchQmdLex(vault, "telescope"); assert.equal(found.state, "successful"); assert.deepEqual(found.matches.map(m => m.path), [good]);
  const excluded = await searchQmdLex(vault, "Operationalneedle"); assert.equal(excluded.state, "successful"); assert.deepEqual(excluded.matches, []);
});

test("wiki:10 CLI inventory indexes the validated read, never an unvalidated later reread", async () => {
  const vault = fresh(), relative = note(vault), captured = read(vault, relative);
  const result = cli(vault, ["search", "sync"], "replace-after-read"); assert.equal(result.status, 0);
  assert.deepEqual(result.data.textCoverage, complete([{ path: relative, digest: digest(captured) }]));
  assert.notEqual(read(vault, relative), captured);
  const found = await searchQmdLex(vault, "telescope"); assert.equal(found.state, "successful"); assert.equal(found.matches[0]?.markdown, captured);
});

for (const dependency of ["missing-sdk", "missing-native"]) test("wiki:10 CLI " + dependency + " maps to exit 7 without preventing ordinary init and show", () => {
  const vault = fresh(), relative = note(vault);
  const result = cli(vault, ["search", "sync"], dependency); assert.equal(result.status, 7); assert.equal(result.data.error.code, "unavailable");
  assert.equal(result.data.textCoverage.state, "unavailable"); assert.equal(result.data.embeddingCoverage.state, "unavailable"); assert.equal(fs.existsSync(receipt(vault)), false);
  const human = cli(vault, ["search", "sync"], dependency, false); assert.equal(human.status, 7); assert.match(human.stderr, /^unavailable:/); assert.match(human.stdout, /Text coverage: unavailable/);
  assert.equal(cli(vault, ["init"], dependency).status, 0); assert.equal(cli(vault, ["show", relative], dependency).status, 0);
});

test("wiki:10 CLI uses only the index lock and reports busy without trusting previous coverage", () => {
  const vault = fresh(), relative = note(vault); succeeds(vault, ["search", "sync"]);
  fs.writeFileSync(path.join(vault, ".wiki/locks/mutation.lock"), "unrelated writer");
  assert.equal(cli(vault, ["search", "sync"]).status, 0);
  fs.writeFileSync(path.join(vault, ".wiki/search/writer.lock"), "index writer");
  const result = cli(vault, ["search", "sync"]); assert.equal(result.status, 3); assert.equal(result.data.error.code, "conflict"); assert.equal(result.data.textCoverage.state, "unavailable");
  const human = cli(vault, ["search", "sync"], "", false); assert.equal(human.status, 3); assert.match(human.stderr, /^conflict:/);
  assert.equal(cli(vault, ["show", relative]).status, 0); assert.equal(cli(vault, ["init"]).status, 0);
  assert.equal(read(vault, ".wiki/search/writer.lock"), "index writer"); assert.equal(read(vault, ".wiki/locks/mutation.lock"), "unrelated writer");
});

test("wiki:10 CLI interrupted sync invalidates the prior receipt and releases its index lock", () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  const result = cli(vault, ["search", "sync"], "interrupt-staging"); assert.equal(result.status, 7); assert.equal(result.data.textCoverage.state, "unavailable");
  assert.equal(fs.existsSync(receipt(vault)), false); assert.equal(fs.existsSync(path.join(vault, ".wiki/search/writer.lock")), false);
  assert.equal(cli(vault, ["search", "sync"]).status, 0);
});

test("wiki:10 CLI rejects unsupported search subcommands and unrelated options before index effects", () => {
  const vault = fresh(); note(vault);
  for (const args of [["search", "find"], ["search", "sync", "extra"], ["search", "sync", "--check"], ["search", "sync", "--folder", "x"], ["search", "sync", "--section", "x"], ["search", "sync", "--personal"]]) {
    const result = cli(vault, args); assert.equal(result.status, 2, JSON.stringify(result)); assert.equal(result.data.error.code, "usage");
  }
  assert.equal(fs.existsSync(path.join(vault, ".wiki/search")), false);
});


test("wiki:10 CLI registry-specific folders and valid vendor/build identities stay canonical", async () => {
  const vault = fresh(); succeeds(vault, ["type", "add", "building", "--folder", "build"]);
  const relative = succeeds(vault, ["new", "building", "--project", "vendor", "--title", "Canonical", "--description", "Canonical quasar"]).path;
  assert.equal(relative, "projects/vendor/build/canonical.md");
  const result = succeeds(vault, ["search", "sync"]); assert.equal(result.textCoverage.state, "complete");
  assert.deepEqual(result.textCoverage, complete([{ path: relative, digest: digest(read(vault, relative)) }]));
  const found = await searchQmdLex(vault, "quasar"); assert.equal(found.state, "successful"); assert.equal(found.matches[0]?.path, relative);
});

test("wiki:10 CLI native close failure stays structured, invalidates coverage and permits recovery", () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  const result = cli(vault, ["search", "sync"], "close-failure"); assert.equal(result.status, 7); assert.equal(result.data.error.code, "unavailable");
  assert.equal(result.data.textCoverage.state, "unavailable"); assert.match(JSON.stringify(result.data.diagnostics), /injected native SQLITE_IOERR/);
  assert.equal(fs.existsSync(receipt(vault)), false); assert.equal(fs.existsSync(path.join(vault, ".wiki/search/writer.lock")), false);
  assert.equal(cli(vault, ["search", "sync"]).status, 0);
});


test("wiki:10 CLI malformed registry yields incomplete coverage rather than a validated concept roster", async () => {
  const vault = fresh(); note(vault); succeeds(vault, ["search", "sync"]);
  fs.writeFileSync(path.join(vault, ".wiki/types/damaged.json"), "{bad json");
  const result = succeeds(vault, ["search", "sync"]); assert.equal(result.textCoverage.state, "incomplete");
  assert.ok(result.diagnostics.some((d: { path: string; rule: string }) => d.path === ".wiki/types/damaged.json" && d.rule === "registry.json"));
  assert.equal(fs.existsSync(receipt(vault)), false);
  const found = await searchQmdLex(vault, "telescope"); assert.equal(found.state, "successful"); assert.deepEqual(found.matches, []);
});


test("wiki:10 CLI unusable derived directory is unavailable, not an invented writer conflict", () => {
  const vault = fresh(), relative = note(vault); fs.writeFileSync(path.join(vault, ".wiki/search"), "not a directory");
  const result = cli(vault, ["search", "sync"]); assert.equal(result.status, 7); assert.equal(result.data.error.code, "unavailable");
  assert.equal(result.data.textCoverage.state, "unavailable"); assert.equal(cli(vault, ["show", relative]).status, 0);
});


test("wiki:10 fresh init and real sync ignore actual derived search state without hiding authored files or rewriting existing ignores", () => {
  const vault = fresh(), relative = note(vault);
  const env = { ...process.env, GIT_DIR: path.join(vault, ".git"), GIT_WORK_TREE: vault, GIT_INDEX_FILE: path.join(vault, ".git/index"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "" };
  function git(args: string[], input?: string) {
    const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "-c", "init.templateDir=", ...args], { cwd: vault, env, input, encoding: "utf8", timeout: 15000 });
    assert.equal(result.error, undefined); assert.equal(result.stderr, ""); return result;
  }
  assert.equal(git(["init", "--quiet"]).status, 0);
  const result = cli(vault, ["search", "sync"], "inspect-active-lock-ignore"); assert.equal(result.status, 0, JSON.stringify(result));
  const search = path.join(vault, ".wiki/search");
  const snapshots = fs.readdirSync(path.join(search, "snapshots")); assert.equal(snapshots.length, 1);
  const actual = [".wiki/search/qmd.sqlite", ".wiki/search/coverage.json", ".wiki/search/identities.json", ".wiki/search/snapshots/" + snapshots[0]];
  for (const file of actual) assert.equal(fs.statSync(path.join(vault, file)).isFile(), true);
  const derived = [".wiki/search/", ...actual, ".wiki/search/qmd.sqlite-wal", ".wiki/search/writer.lock"];
  const ignored = git(["check-ignore", "--no-index", "--stdin"], derived.join("\n") + "\n");
  assert.equal(ignored.status, 0, "Actual derived search paths must be ignored: " + ignored.stdout);
  assert.deepEqual(ignored.stdout.trim().split("\n"), derived);
  const active = JSON.parse(read(vault, ".wiki/tmp/active-lock-ignore.json"));
  assert.equal(active.exists, true); assert.equal(active.status, 0); assert.equal(active.stdout.trim(), ".wiki/search/writer.lock"); assert.equal(active.stderr, "");
  const oldControls = [".wiki/tmp/test", ".wiki/locks/mutation.lock", ".wiki/qmd.sqlite", ".wiki/qmd.sqlite-wal"];
  assert.deepEqual(git(["check-ignore", "--no-index", "--stdin"], oldControls.join("\n") + "\n").stdout.trim().split("\n"), oldControls);
  const authored = [relative, ".wiki/types/note.json", ".wiki/config.json", ".gitignore"];
  const visible = git(["check-ignore", "--no-index", "--stdin"], authored.join("\n") + "\n"); assert.equal(visible.status, 1); assert.equal(visible.stdout, "");
  assert.equal(git(["add", "--", ...authored]).status, 0);
  assert.deepEqual(git(["ls-files"]).stdout.trim().split("\n").sort(), authored.sort());
  // Existing authored files, including older generated rules, are never auto-migrated.
  const existing = "# Owner-authored ignore rules\n/private/\n/.wiki/tmp/\n/.wiki/locks/\n/.wiki/qmd.sqlite\n/.wiki/qmd.sqlite-*\n";
  fs.writeFileSync(path.join(vault, ".gitignore"), existing);
  succeeds(vault, ["init"]); assert.equal(read(vault, ".gitignore"), existing);
  succeeds(vault, ["search", "sync"]); assert.equal(read(vault, ".gitignore"), existing);
  const notMigrated = git(["check-ignore", "--no-index", ".wiki/search/qmd.sqlite"]); assert.equal(notMigrated.status, 1); assert.equal(notMigrated.stdout, "");
});
