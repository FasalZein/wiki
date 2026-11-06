import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-update-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const relative = "personal/notes/topic.md";
function digest(bytes: string | Buffer) { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
function cli(vault: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [BIN, "--json", "--vault", vault, ...args], {
    encoding: "utf8", cwd: temp, env: { ...process.env, HOME: temp, WIKI_VAULT: "" }, timeout: 15000,
  });
  assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  return { status: result.status, data: JSON.parse(result.stdout) };
}
function succeeds(vault: string, ...args: string[]) {
  const result = cli(vault, ...args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data;
}
function read(vault: string, file = relative) { return fs.readFileSync(path.join(vault, file), "utf8"); }
function candidate(bytes: string | Buffer) {
  const file = path.join(temp, "candidate-" + ++counter + ".md"); fs.writeFileSync(file, bytes); return file;
}
function fresh() {
  const vault = path.join(temp, String(++counter)); succeeds(vault, "init");
  const note = succeeds(vault, "new", "note", "--personal", "--title", "Topic", "--description", "Original description");
  return { vault, note, bytes: read(vault) };
}
function update(vault: string, expect: string, file: string, ...args: string[]) {
  return cli(vault, "update", relative, "--expect", expect, "--file", file, ...args);
}
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isDirectory() ? snapshot(full) : stat.isFile() ? fs.readFileSync(full).toString("base64") : "special"];
  });
}

test("okf:08 applies exact complete candidate bytes with resulting digest, navigation and one updated log", () => {
  const { vault, note, bytes } = fresh();
  const proposed = "\uFEFF" + bytes.replace('"Topic"', '"Revised topic"').replace("Original description", "Revised description").replace(/\n/g, "\r\n") + "Retained trailing spaces  ";
  const result = update(vault, note.digest, candidate(proposed));
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.data.outcome, "updated"); assert.equal(result.data.written, true);
  assert.equal(result.data.digest, digest(proposed)); assert.equal(result.data.path, relative);
  assert.equal(result.data.navigation, "updated"); assert.equal(result.data.log, "appended");
  assert.deepEqual(fs.readFileSync(path.join(vault, relative)), Buffer.from(proposed));
  assert.match(read(vault, "personal/notes/index.md"), /Revised topic/);
  assert.equal(read(vault, "log.md").split("**updated**").length - 1, 1);
  succeeds(vault, "lint"); succeeds(vault, "index", "--check");
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
});

function refused(vault: string, status: number, expect: string, file: string, ...args: string[]) {
  const before = snapshot(vault), result = update(vault, expect, file, ...args);
  assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.data.ok, false);
  assert.equal(result.data.written, undefined); assert.deepEqual(snapshot(vault), before);
  return result.data;
}

test("okf:08 stale full-byte digest returns path and expected/current without effects", () => {
  const { vault, note, bytes } = fresh();
  const current = bytes + "External edit\n"; fs.writeFileSync(path.join(vault, relative), current);
  const result = refused(vault, 3, note.digest, candidate(bytes + "Candidate\n"));
  assert.equal(result.path, relative); assert.equal(result.expected, note.digest); assert.equal(result.current, digest(current));
  assert.match(result.error.message, /re-read.*do not retry/);
});

test("okf:08 dry-run gives focused diff and candidate digest without even attempting a vault write", () => {
  const { vault, note, bytes } = fresh();
  const proposed = bytes + "Added fact\n", file = candidate(proposed), before = snapshot(vault);
  const result = guarded(vault, note.digest, file, "read-only", "--dry-run");
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.data.outcome, "dry-run");
  assert.equal(result.data.written, undefined); assert.equal(result.data.candidateDigest, digest(proposed));
  assert.equal(result.data.summary.candidateBytes, Buffer.byteLength(proposed));
  assert.ok(result.data.diff.added.includes("Added fact")); assert.deepEqual(snapshot(vault), before);
  fs.writeFileSync(path.join(vault, ".wiki/locks/mutation.lock"), "held");
  assert.equal(update(vault, note.digest, file, "--dry-run").status, 0);
  refused(vault, 3, note.digest, file);
});

test("okf:08 same-byte apply is an unchanged no-op with no new log or navigation writes", () => {
  const { vault, note, bytes } = fresh(), before = snapshot(vault);
  const result = guarded(vault, note.digest, candidate(bytes), "no-op");
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.data.outcome, "unchanged");
  assert.equal(result.data.written, undefined); assert.equal(result.data.digest, note.digest);
  assert.equal(result.data.log, "unchanged"); assert.deepEqual(snapshot(vault), before);
});

for (const kind of ["missing", "directory", "symlink", "ancestor", "fifo"] as const) test("okf:08 missing or unsafe target is refused: " + kind, () => {
  const { vault, note, bytes } = fresh(), full = path.join(vault, relative), file = candidate(bytes + "New\n");
  fs.unlinkSync(full);
  if (kind === "directory") fs.mkdirSync(full);
  if (kind === "symlink") fs.symlinkSync(file, full);
  if (kind === "ancestor") { fs.rmSync(path.dirname(full), { recursive: true }); fs.symlinkSync(temp, path.dirname(full)); }
  if (kind === "fifo") assert.equal(spawnSync("mkfifo", [full]).status, 0);
  refused(vault, kind === "missing" ? 4 : 2, note.digest, file);
});

for (const [label, change] of [
  ["yaml", () => "---\ninvalid: [\n---\n"],
  ["type-path", (s: string) => s.replace('"note"', '"procedure"')],
  ["body-link", (s: string) => s + "[missing](missing.md)\n"],
  ["schema", (s: string) => s.replace("description:", "unknown:")],
] as const) test("okf:08 invalid complete candidate is refused: " + label, () => {
  const { vault, note, bytes } = fresh(); refused(vault, 2, note.digest, candidate(change(bytes)));
});

test("okf:08 duplicate normalized scoped title is refused across type folders", () => {
  const { vault, note, bytes } = fresh();
  succeeds(vault, "new", "architecture", "--personal", "--title", "Straße", "--description", "Existing title");
  refused(vault, 3, note.digest, candidate(bytes.replace('"Topic"', '" STRASSE "')));
});

test("okf:08 replacement drops superseded diagnostics and validates incoming references and unrelated notes", () => {
  const { vault, bytes } = fresh();
  fs.writeFileSync(path.join(vault, relative), "---\nbad: [\n---\n");
  const repaired = update(vault, digest(read(vault)), candidate(bytes)); assert.equal(repaired.status, 0, JSON.stringify(repaired));
  succeeds(vault, "new", "note", "--personal", "--title", "Other", "--description", "Other description");
  const other = "personal/notes/other.md", original = read(vault, other);
  fs.writeFileSync(path.join(vault, other), original + "[incoming](topic.md)\n");
  assert.equal(update(vault, digest(read(vault)), candidate(bytes + "Valid fact\n")).status, 0);
  fs.writeFileSync(path.join(vault, other), original + "[missing](missing.md)\n");
  const result = refused(vault, 2, digest(read(vault)), candidate(bytes));
  assert.ok(result.diagnostics.some((d: { path: string }) => d.path === other));
});

for (const kind of ["directory", "fifo", "symlink", "utf8"] as const) test("okf:08 candidate consumption promptly refuses unsupported input: " + kind, () => {
  const { vault, note, bytes } = fresh();
  const file = path.join(temp, "unsupported-" + ++counter);
  if (kind === "directory") fs.mkdirSync(file);
  if (kind === "fifo") assert.equal(spawnSync("mkfifo", [file]).status, 0);
  if (kind === "symlink") fs.symlinkSync(candidate(bytes), file);
  if (kind === "utf8") fs.writeFileSync(file, Buffer.from([0xff]));
  refused(vault, 2, note.digest, file);
});

function guarded(vault: string, expect: string, file: string, mode: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./update-io-guard.js", import.meta.url)), BIN, "--json", "--vault", vault, "update", relative, "--expect", expect, "--file", file, ...args], {
    encoding: "utf8", cwd: temp, env: { ...process.env, HOME: temp, WIKI_VAULT: "", OKF_UPDATE_GUARD: mode }, timeout: 15000,
  });
  assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return { status: result.status, data: JSON.parse(result.stdout) };
}

for (const mode of ["stale-final", "missing-final", "unsafe-final"]) test("okf:08 final target recheck after temp preparation rejects: " + mode, () => {
  const { vault, note, bytes } = fresh(), log = read(vault, "log.md"), index = read(vault, "index.md");
  const result = guarded(vault, note.digest, candidate(bytes + "Candidate\n"), mode);
  assert.equal(result.status, mode === "stale-final" ? 3 : mode === "missing-final" ? 4 : 2, JSON.stringify(result));
  assert.equal(result.data.written, undefined);
  if (mode === "stale-final") {
    assert.equal(read(vault), "External writer bytes\n");
    assert.equal(result.data.expected, note.digest); assert.equal(result.data.current, digest("External writer bytes\n"));
  }
  assert.equal(read(vault, "log.md"), log); assert.equal(read(vault, "index.md"), index);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
});

for (const mode of ["index-fail", "log-fail", "release-fail", "index-release-fail"]) test("okf:08 publication and release failures retain truthful final metadata: " + mode, () => {
  const { vault, note, bytes } = fresh(), proposed = bytes + "Published\n", log = read(vault, "log.md");
  const result = guarded(vault, note.digest, candidate(proposed), mode);
  assert.notEqual(result.status, 0); assert.equal(result.data.ok, false); assert.equal(result.data.written, true);
  assert.deepEqual(result.data.paths, [relative]); assert.equal(result.data.digest, digest(proposed)); assert.equal(read(vault), proposed);
  if (mode !== "release-fail") { assert.match(result.data.error.message, /run index.*inspect log.md/); assert.equal(read(vault, "log.md"), log); }
  if (mode.includes("release")) assert.equal(result.data.cleanup.retained, true);
  if (mode === "release-fail") assert.equal(result.data.outcome, "completed");
});

test("okf:08 temporary cleanup failure preserves the primary stale conflict", () => {
  const { vault, note, bytes } = fresh();
  const result = guarded(vault, note.digest, candidate(bytes + "Candidate\n"), "stale-cleanup-fail");
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.error.code, "conflict");
  assert.equal(result.data.expected, note.digest); assert.equal(result.data.current, digest("External writer bytes\n"));
  assert.equal(result.data.written, undefined); assert.match(result.data.temporaryCleanup.path, /^\.wiki\/tmp\//);
  assert.equal(result.data.temporaryCleanup.retained, true);
});

test("okf:08 strict command-local flags and lowercase full digest syntax", () => {
  const { vault, note, bytes } = fresh(), file = candidate(bytes);
  for (const expect of ["sha256:abc", note.digest.toUpperCase(), note.digest + "0", ""]) refused(vault, 2, expect, file);
  for (const args of [["--project", "wiki"], ["--personal"], ["--title", "Other"], ["--section", "Body"], ["--check"], ["--folder", "notes"]]) refused(vault, 2, note.digest, file, ...args);
  for (const args of [["show", relative, "--expect", note.digest], ["index", "--dry-run"], ["lint", "--file", file], ["update", relative], ["update", relative, "extra", "--expect", note.digest, "--file", file]]) {
    const before = snapshot(vault); assert.equal(cli(vault, ...args).status, 2); assert.deepEqual(snapshot(vault), before);
  }
});

test("okf:08 human update and conflict output contain identity and digests", () => {
  const { vault, note, bytes } = fresh(), file = candidate(bytes + "Fact\n");
  const args = [BIN, "--vault", vault, "update", relative, "--expect", note.digest, "--file", file];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Updated topic: personal\/notes\/topic.md/);
  assert.ok(result.stdout.includes(digest(bytes + "Fact\n"))); assert.match(result.stdout, /Navigation: updated; log: appended/);
  const stale = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000 });
  assert.equal(stale.status, 3); assert.equal(stale.stdout, "");
  assert.ok(stale.stderr.includes(note.digest)); assert.ok(stale.stderr.includes(digest(bytes + "Fact\n")));
});


test("okf:08 candidate swapped to FIFO at open is refused without blocking", () => {
  const { vault, note, bytes } = fresh(), before = snapshot(vault);
  const result = guarded(vault, note.digest, candidate(bytes + "Candidate\n"), "candidate-fifo");
  assert.equal(result.status, 2, JSON.stringify(result)); assert.equal(result.data.written, undefined);
  assert.deepEqual(snapshot(vault), before);
});

test("okf:08 unsafe generated destination refuses update before content publication", () => {
  const { vault, note, bytes } = fresh(), index = path.join(vault, "personal/notes/index.md");
  fs.unlinkSync(index); fs.mkdirSync(index);
  const result = refused(vault, 2, note.digest, candidate(bytes + "Candidate\n"));
  assert.ok(result.diagnostics.some((d: { path: string }) => d.path === "personal/notes/index.md"));
});

test("okf:08 conflict plus temporary and lock cleanup failures preserve all diagnostics", () => {
  const { vault, note, bytes } = fresh();
  const result = guarded(vault, note.digest, candidate(bytes + "Candidate\n"), "stale-cleanup-release-fail");
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.error.code, "conflict");
  assert.equal(result.data.current, digest("External writer bytes\n")); assert.equal(result.data.expected, note.digest);
  assert.equal(result.data.temporaryCleanup.retained, true); assert.equal(result.data.cleanup.retained, true);
  assert.equal(result.data.written, undefined);
});

test("okf:08 no-op release failure never reports written or adds a historical entry", () => {
  const { vault, note, bytes } = fresh(), log = read(vault, "log.md");
  const result = guarded(vault, note.digest, candidate(bytes), "release-fail");
  assert.notEqual(result.status, 0); assert.equal(result.data.written, undefined);
  assert.equal(result.data.cleanup.retained, true); assert.equal(read(vault), bytes); assert.equal(read(vault, "log.md"), log);
});
