import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, runJson as cli, spawnJson } from "./cli-helper.ts";
import { fileURLToPath } from "node:url";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-update-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const relative = "personal/notes/topic.md";
function digest(bytes: string | Buffer) { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
async function succeeds(vault: string, ...args: string[]) {
  const result = await cli(vault, ...args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data;
}
function read(vault: string, file = relative) { return fs.readFileSync(path.join(vault, file), "utf8"); }
function candidate(bytes: string | Buffer) {
  const file = path.join(temp, "candidate-" + ++counter + ".md"); fs.writeFileSync(file, bytes); return file;
}
async function fresh() {
  const vault = path.join(temp, String(++counter)); await succeeds(vault, "init");
  const note = await succeeds(vault, "new", "note", "--personal", "--title", "Topic", "--description", "Original description");
  return { vault, note, bytes: read(vault) };
}
async function update(vault: string, expect: string, file: string, ...args: string[]) {
  return await cli(vault, "update", relative, "--expect", expect, "--file", file, ...args);
}
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isDirectory() ? snapshot(full) : stat.isFile() ? fs.readFileSync(full).toString("base64") : "special"];
  });
}

test("wiki:08 applies exact complete candidate bytes with resulting digest, navigation and one updated log", async () => {
  const { vault, note, bytes } = await fresh();
  const proposed = "\uFEFF" + bytes.replace('"Topic"', '"Revised topic"').replace("Original description", "Revised description").replace(/\n/g, "\r\n") + "Retained trailing spaces  ";
  const result = await update(vault, note.digest, candidate(proposed));
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.data.outcome, "updated"); assert.equal(result.data.written, true);
  assert.equal(result.data.digest, digest(proposed)); assert.equal(result.data.path, relative);
  assert.equal(result.data.navigation, "updated"); assert.equal(result.data.log, "appended");
  assert.deepEqual(fs.readFileSync(path.join(vault, relative)), Buffer.from(proposed));
  assert.match(read(vault, "personal/notes/index.md"), /Revised topic/);
  assert.equal(read(vault, "log.md").split("**updated**").length - 1, 1);
  await succeeds(vault, "lint"); await succeeds(vault, "index", "--check");
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
});

async function refused(vault: string, status: number, expect: string, file: string, ...args: string[]) {
  const before = snapshot(vault), result = await update(vault, expect, file, ...args);
  assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.data.ok, false);
  assert.equal(result.data.written, undefined); assert.deepEqual(snapshot(vault), before);
  return result.data;
}

test("wiki:08 stale full-byte digest returns path and expected/current without effects", async () => {
  const { vault, note, bytes } = await fresh();
  const current = bytes + "External edit\n"; fs.writeFileSync(path.join(vault, relative), current);
  const result = await refused(vault, 3, note.digest, candidate(bytes + "Candidate\n"));
  assert.equal(result.path, relative); assert.equal(result.expected, note.digest); assert.equal(result.current, digest(current));
  assert.match(result.error.message, /re-read.*do not retry/);
});

test("wiki:08 dry-run gives focused diff and candidate digest without even attempting a vault write", async () => {
  const { vault, note, bytes } = await fresh();
  const proposed = bytes + "Added fact\n", file = candidate(proposed), before = snapshot(vault);
  const result = await guarded(vault, note.digest, file, "read-only", "--dry-run");
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.data.outcome, "dry-run");
  assert.equal(result.data.written, undefined); assert.equal(result.data.candidateDigest, digest(proposed));
  assert.equal(result.data.summary.candidateBytes, Buffer.byteLength(proposed));
  assert.ok(result.data.diff.added.includes("Added fact")); assert.deepEqual(snapshot(vault), before);
  fs.writeFileSync(path.join(vault, ".wiki/locks/mutation.lock"), "held");
  assert.equal((await update(vault, note.digest, file, "--dry-run")).status, 0);
  await refused(vault, 3, note.digest, file);
});

test("wiki:08 same-byte apply is an unchanged no-op with no new log or navigation writes", async () => {
  const { vault, note, bytes } = await fresh(), before = snapshot(vault);
  const result = await guarded(vault, note.digest, candidate(bytes), "no-op");
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.data.outcome, "unchanged");
  assert.equal(result.data.written, undefined); assert.equal(result.data.digest, note.digest);
  assert.equal(result.data.log, "unchanged"); assert.deepEqual(snapshot(vault), before);
});

for (const kind of ["missing", "directory", "symlink", "ancestor", "fifo"] as const) test("wiki:08 missing or unsafe target is refused: " + kind, async () => {
  const { vault, note, bytes } = await fresh(), full = path.join(vault, relative), file = candidate(bytes + "New\n");
  fs.unlinkSync(full);
  if (kind === "directory") fs.mkdirSync(full);
  if (kind === "symlink") fs.symlinkSync(file, full);
  if (kind === "ancestor") { fs.rmSync(path.dirname(full), { recursive: true }); fs.symlinkSync(temp, path.dirname(full)); }
  if (kind === "fifo") assert.equal(spawnSync("mkfifo", [full]).status, 0);
  await refused(vault, kind === "missing" ? 4 : 2, note.digest, file);
});

for (const [label, change] of [
  ["yaml", () => "---\ninvalid: [\n---\n"],
  ["type-path", (s: string) => s.replace('"note"', '"procedure"')],
  ["body-link", (s: string) => s + "[missing](missing.md)\n"],
  ["schema", (s: string) => s.replace("description:", "unknown:")],
] as const) test("wiki:08 invalid complete candidate is refused: " + label, async () => {
  const { vault, note, bytes } = await fresh(); await refused(vault, 2, note.digest, candidate(change(bytes)));
});

test("wiki:08 duplicate normalized scoped title is refused across type folders", async () => {
  const { vault, note, bytes } = await fresh();
  await succeeds(vault, "new", "architecture", "--personal", "--title", "Straße", "--description", "Existing title");
  await refused(vault, 3, note.digest, candidate(bytes.replace('"Topic"', '" STRASSE "')));
});

test("wiki:08 replacement drops superseded diagnostics and validates incoming references and unrelated notes", async () => {
  const { vault, bytes } = await fresh();
  fs.writeFileSync(path.join(vault, relative), "---\nbad: [\n---\n");
  const repaired = await update(vault, digest(read(vault)), candidate(bytes)); assert.equal(repaired.status, 0, JSON.stringify(repaired));
  await succeeds(vault, "new", "note", "--personal", "--title", "Other", "--description", "Other description");
  const other = "personal/notes/other.md", original = read(vault, other);
  fs.writeFileSync(path.join(vault, other), original + "[incoming](topic.md)\n");
  assert.equal((await update(vault, digest(read(vault)), candidate(bytes + "Valid fact\n"))).status, 0);
  fs.writeFileSync(path.join(vault, other), original + "[missing](missing.md)\n");
  const result = await refused(vault, 2, digest(read(vault)), candidate(bytes));
  assert.ok(result.diagnostics.some((d: { path: string }) => d.path === other));
});

for (const kind of ["directory", "fifo", "symlink", "utf8"] as const) test("wiki:08 candidate consumption promptly refuses unsupported input: " + kind, async () => {
  const { vault, note, bytes } = await fresh();
  const file = path.join(temp, "unsupported-" + ++counter);
  if (kind === "directory") fs.mkdirSync(file);
  if (kind === "fifo") assert.equal(spawnSync("mkfifo", [file]).status, 0);
  if (kind === "symlink") fs.symlinkSync(candidate(bytes), file);
  if (kind === "utf8") fs.writeFileSync(file, Buffer.from([0xff]));
  await refused(vault, 2, note.digest, file);
});

// The update I/O guard patches fs per process, so guarded updates stay in a subprocess.
async function guarded(vault: string, expect: string, file: string, mode: string, ...args: string[]) {
  return spawnJson(["--vault", vault, "update", relative, "--expect", expect, "--file", file, ...args], {
    imports: [fileURLToPath(new URL("./update-io-guard.js", import.meta.url))], cwd: temp, timeout: 15000,
    env: { HOME: temp, WIKI_UPDATE_GUARD: mode, WIKI_UPDATE_MODE_EVENTS: file + ".events.json" },
  });
}

for (const mode of ["stale-final", "missing-final", "unsafe-final"]) test("wiki:08 final target recheck after temp preparation rejects: " + mode, async () => {
  const { vault, note, bytes } = await fresh(), log = read(vault, "log.md"), index = read(vault, "index.md");
  const result = await guarded(vault, note.digest, candidate(bytes + "Candidate\n"), mode);
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

for (const mode of ["index-fail", "log-fail", "release-fail", "index-release-fail"]) test("wiki:08 publication and release failures retain truthful final metadata: " + mode, async () => {
  const { vault, note, bytes } = await fresh(), proposed = bytes + "Published\n", log = read(vault, "log.md");
  const result = await guarded(vault, note.digest, candidate(proposed), mode);
  assert.notEqual(result.status, 0); assert.equal(result.data.ok, false); assert.equal(result.data.written, true);
  assert.deepEqual(result.data.paths, [relative]); assert.equal(result.data.digest, digest(proposed)); assert.equal(read(vault), proposed);
  if (mode !== "release-fail") { assert.match(result.data.error.message, /run index.*inspect log.md/); assert.equal(read(vault, "log.md"), log); }
  if (mode.includes("release")) assert.equal(result.data.cleanup.retained, true);
  if (mode === "release-fail") assert.equal(result.data.outcome, "completed");
});

test("wiki:08 temporary cleanup failure preserves the primary stale conflict", async () => {
  const { vault, note, bytes } = await fresh();
  const result = await guarded(vault, note.digest, candidate(bytes + "Candidate\n"), "stale-cleanup-fail");
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.error.code, "conflict");
  assert.equal(result.data.expected, note.digest); assert.equal(result.data.current, digest("External writer bytes\n"));
  assert.equal(result.data.written, undefined); assert.match(result.data.temporaryCleanup.path, /^\.wiki\/tmp\//);
  assert.equal(result.data.temporaryCleanup.retained, true);
});

test("wiki:08 strict command-local flags and lowercase full digest syntax", async () => {
  const { vault, note, bytes } = await fresh(), file = candidate(bytes);
  for (const expect of ["sha256:abc", note.digest.toUpperCase(), note.digest + "0", ""]) await refused(vault, 2, expect, file);
  for (const args of [["--project", "wiki"], ["--personal"], ["--title", "Other"], ["--section", "Body"], ["--check"], ["--folder", "notes"]]) await refused(vault, 2, note.digest, file, ...args);
  for (const args of [["show", relative, "--expect", note.digest], ["index", "--dry-run"], ["lint", "--file", file], ["update", relative], ["update", relative, "extra", "--expect", note.digest, "--file", file]]) {
    const before = snapshot(vault); assert.equal((await cli(vault, ...args)).status, 2); assert.deepEqual(snapshot(vault), before);
  }
});

test("wiki:08 human update and conflict output contain identity and digests", async () => {
  const { vault, note, bytes } = await fresh(), file = candidate(bytes + "Fact\n");
  const args = ["--vault", vault, "update", relative, "--expect", note.digest, "--file", file];
  const result = await runCli(args);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Updated topic: personal\/notes\/topic.md/);
  assert.ok(result.stdout.includes(digest(bytes + "Fact\n"))); assert.match(result.stdout, /Navigation: updated; log: appended/);
  const stale = await runCli(args);
  assert.equal(stale.status, 3); assert.equal(stale.stdout, "");
  assert.ok(stale.stderr.includes(note.digest)); assert.ok(stale.stderr.includes(digest(bytes + "Fact\n")));
});


test("wiki:08 candidate swapped to FIFO at open is refused without blocking", async () => {
  const { vault, note, bytes } = await fresh(), before = snapshot(vault);
  const result = await guarded(vault, note.digest, candidate(bytes + "Candidate\n"), "candidate-fifo");
  assert.equal(result.status, 2, JSON.stringify(result)); assert.equal(result.data.written, undefined);
  assert.deepEqual(snapshot(vault), before);
});

test("wiki:08 unsafe generated destination refuses update before content publication", async () => {
  const { vault, note, bytes } = await fresh(), index = path.join(vault, "personal/notes/index.md");
  fs.unlinkSync(index); fs.mkdirSync(index);
  const result = await refused(vault, 2, note.digest, candidate(bytes + "Candidate\n"));
  assert.ok(result.diagnostics.some((d: { path: string }) => d.path === "personal/notes/index.md"));
});

test("wiki:08 conflict plus temporary and lock cleanup failures preserve all diagnostics", async () => {
  const { vault, note, bytes } = await fresh();
  const result = await guarded(vault, note.digest, candidate(bytes + "Candidate\n"), "stale-cleanup-release-fail");
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.error.code, "conflict");
  assert.equal(result.data.current, digest("External writer bytes\n")); assert.equal(result.data.expected, note.digest);
  assert.equal(result.data.temporaryCleanup.retained, true); assert.equal(result.data.cleanup.retained, true);
  assert.equal(result.data.written, undefined);
});

test("wiki:08 no-op release failure never reports written or adds a historical entry", async () => {
  const { vault, note, bytes } = await fresh(), log = read(vault, "log.md");
  const result = await guarded(vault, note.digest, candidate(bytes), "release-fail");
  assert.notEqual(result.status, 0); assert.equal(result.data.written, undefined);
  assert.equal(result.data.cleanup.retained, true); assert.equal(read(vault), bytes); assert.equal(read(vault, "log.md"), log);
});


for (const [targetMode, candidateMode] of [[0o600, 0o600], [0o640, 0o600], [0o400, 0o644]] as const) test("wiki:08 permissions private first-write and target access preserved: " + targetMode.toString(8), async () => {
  const { vault, note, bytes } = await fresh(), proposed = bytes + "Synthetic private candidate\n", file = candidate(proposed);
  fs.chmodSync(path.join(vault, relative), targetMode); fs.chmodSync(file, candidateMode);
  fs.chmodSync(path.join(vault, ".wiki/tmp"), 0o755);
  const result = await guarded(vault, note.digest, file, "permissions");
  const events = JSON.parse(fs.readFileSync(file + ".events.json", "utf8"));
  assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.data.outcome, "updated");
  assert.deepEqual({ events, targetMode: fs.statSync(path.join(vault, relative)).mode & 0o777 }, {
    events: [{ event: "created", mode: 0o600, size: 0 }, { event: "written", mode: 0o600, size: Buffer.byteLength(proposed) }], targetMode,
  });
  assert.equal(fs.statSync(file).mode & 0o777, candidateMode);
  assert.equal(read(vault), proposed); assert.equal(result.data.digest, digest(proposed));
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
});

test("wiki:08 permissions stale conflict retains private candidate after cleanup failure", async () => {
  const { vault, note, bytes } = await fresh(), proposed = bytes + "Synthetic private candidate\n", file = candidate(proposed);
  fs.chmodSync(path.join(vault, relative), 0o600); fs.chmodSync(file, 0o600);
  fs.chmodSync(path.join(vault, ".wiki/tmp"), 0o755);
  const result = await guarded(vault, note.digest, file, "stale-cleanup-permissions");
  const events = JSON.parse(fs.readFileSync(file + ".events.json", "utf8"));
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.error.code, "conflict");
  assert.equal(result.data.written, undefined); assert.equal(result.data.expected, note.digest);
  assert.equal(result.data.current, digest("External writer bytes\n")); assert.equal(result.data.temporaryCleanup.retained, true);
  const retained = path.join(vault, result.data.temporaryCleanup.path);
  assert.deepEqual({ events, retainedMode: fs.statSync(retained).mode & 0o777 }, {
    events: [{ event: "created", mode: 0o600, size: 0 }, { event: "written", mode: 0o600, size: Buffer.byteLength(proposed) }], retainedMode: 0o600,
  });
  assert.equal(fs.readFileSync(retained, "utf8"), proposed);
  assert.equal(fs.statSync(path.join(vault, relative)).mode & 0o777, 0o600);
  assert.equal(read(vault), "External writer bytes\n");
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
});
