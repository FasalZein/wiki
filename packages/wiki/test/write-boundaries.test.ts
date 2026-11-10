import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runJson, spawnCli, spawnJson } from "./cli-helper.ts";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./cleanup-permission-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-boundaries-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
// The cleanup permission guard patches fs per process, so guarded runs stay in a subprocess.
async function cli(vault: string, args: string[], mode?: string) {
  if (!mode) return runJson(vault, ...args);
  return spawnJson(["--vault", vault, ...args], { imports: [GUARD], cwd: temp, env: { HOME: temp, WIKI_CLEANUP_MODE: mode, WIKI_GUARD_VAULT: vault } });
}
async function fresh() {
  const vault = path.join(temp, String(++counter));
  assert.equal((await cli(vault, ["init"])).status, 0);
  return vault;
}
function digest(vault: string, relative: string) { return "sha256:" + createHash("sha256").update(fs.readFileSync(path.join(vault, relative))).digest("hex"); }
function restore(vault: string) {
  for (const directory of [".wiki/tmp", ".wiki/locks", "personal/notes"]) {
    const full = path.join(vault, directory);
    if (fs.existsSync(full)) fs.chmodSync(full, 0o700);
  }
  for (const file of ["log.md", "personal/index.md"]) {
    const full = path.join(vault, file);
    if (fs.existsSync(full)) fs.chmodSync(full, 0o600);
  }
}
const NEW = ["new", "note", "--personal", "--title", "Topic", "--description", "A topic"];
const ADD = ["type", "add", "glossary", "--folder", "glossary"];

test("wiki:07 lock acquisition permission errors preserve the original failure and perform no publication", async () => {
  const vault = await fresh();
  const beforeIndex = fs.readFileSync(path.join(vault, "index.md"));
  fs.chmodSync(path.join(vault, ".wiki/locks"), 0o500);
  try {
    const result = await cli(vault, NEW);
    assert.equal(result.status, 1);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error.code, "internal");
    assert.match(result.data.error.message, /EACCES.*mutation\.lock/);
    assert.equal(result.data.written, undefined);
    assert.equal(result.data.cleanup, undefined);
    assert.equal(fs.existsSync(path.join(vault, "personal/notes/topic.md")), false);
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), "");
    assert.deepEqual(fs.readFileSync(path.join(vault, "index.md")), beforeIndex);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
  } finally { restore(vault); }
});

for (const [command, args, relative] of [["new", NEW, "personal/notes/topic.md"], ["type add", ADD, ".wiki/types/glossary.json"]] as const) test("wiki:07 F1 published " + command + " survives failed temporary-name cleanup with truthful metadata", async () => {
  const vault = await fresh();
  try {
    const beforeIndex = fs.readFileSync(path.join(vault, "index.md"));
    const result = await cli(vault, [...args], "temporary");
    assert.notEqual(result.status, 0);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [relative]);
    assert.equal(result.data.digest, digest(vault, relative));
    assert.match(result.data.error.message, /published.*temporary/i);
    assert.match(result.data.error.message, /inspect.*log|log.*inspect/i);
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), "");
    assert.deepEqual(fs.readFileSync(path.join(vault, "index.md")), beforeIndex);
    const names = fs.readdirSync(path.join(vault, ".wiki/tmp"));
    assert.equal(names.length, 1);
    assert.equal(result.data.temporaryPath, ".wiki/tmp/" + names[0]);
    assert.deepEqual(fs.readFileSync(path.join(vault, result.data.temporaryPath)), fs.readFileSync(path.join(vault, relative)));
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
  } finally { restore(vault); }
});


for (const [command, args, relative, mode, action] of [
  ["new", NEW, "personal/notes/topic.md", "release-log", "created"],
  ["type add", ADD, ".wiki/types/glossary.json", "release-log", "type-added"],
  ["index", ["index"], "index.md", "release-index", undefined],
] as const) test("wiki:07 F2 " + command + " emits one final error with completed metadata when release fails", async () => {
  const vault = await fresh();
  try {
    const result = await cli(vault, [...args], mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.outcome, "completed");
    assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [relative]);
    if (command === "index") assert.deepEqual(result.data.digests, { [relative]: digest(vault, relative) });
    else assert.equal(result.data.digest, digest(vault, relative));
    assert.equal(result.data.cleanup.path, ".wiki/locks/mutation.lock");
    assert.equal(result.data.cleanup.retained, true);
    assert.match(result.data.cleanup.message, /EACCES|permission denied/i);
    assert.match(result.data.error.message, /release.*lock|lock.*release/i);
    assert.ok(fs.existsSync(path.join(vault, ".wiki/locks/mutation.lock")));
    const log = fs.readFileSync(path.join(vault, "log.md"), "utf8");
    assert.equal(action ? log.split("**" + action + "**").length - 1 : log.length, action ? 1 : 0);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
  } finally { restore(vault); }
});

for (const [command, args, relative] of [["new", NEW, "personal/notes/topic.md"], ["type add", ADD, ".wiki/types/glossary.json"]] as const) test("wiki:07 F2 keeps primary publication-cleanup error and metadata when release also fails: " + command, async () => {
  const vault = await fresh();
  try {
    const result = await cli(vault, [...args], "both");
    assert.notEqual(result.status, 0);
    assert.equal(result.data.error.code, "damaged");
    assert.match(result.data.error.message, /published.*temporary/i);
    assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [relative]);
    assert.equal(result.data.digest, digest(vault, relative));
    assert.equal(typeof result.data.temporaryPath, "string");
    assert.equal(result.data.cleanup.retained, true);
    assert.match(result.data.cleanup.message, /EACCES|permission denied/i);
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), "");
  } finally { restore(vault); }
});

for (const command of ["new", "index"]) test("wiki:07 F2 retains primary validation failure when release also fails: " + command, async () => {
  const vault = await fresh();
  try {
    let args = [...NEW, "--status", "invalid"];
    if (command === "index") {
      fs.mkdirSync(path.join(vault, "personal/notes"), { recursive: true });
      fs.writeFileSync(path.join(vault, "personal/notes/broken.md"), "---\ninvalid: [\n---\n");
      args = ["index"];
    }
    const indexBefore = fs.readFileSync(path.join(vault, "index.md"));
    const result = await cli(vault, args, "release-record");
    assert.notEqual(result.status, 0);
    assert.equal(result.data.error.code, command === "new" ? "usage" : "lint");
    assert.ok(result.data.diagnostics.length > 0);
    assert.equal(result.data.written, undefined);
    assert.equal(result.data.cleanup.retained, true);
    assert.deepEqual(fs.readFileSync(path.join(vault, "index.md")), indexBefore);
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), "");
    assert.equal(fs.existsSync(path.join(vault, "personal/notes/topic.md")), false);
  } finally { restore(vault); }
});


function snapshot(directory: string): unknown[] {
  return fs.readdirSync(directory).sort().map(name => {
    const full = path.join(directory, name), stat = fs.lstatSync(full);
    return [name, stat.mode, stat.isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")];
  });
}
for (const location of ["body", "title"]) test("wiki:07 F3 damaged existing UTF-8 in " + location + " blocks lint, index and prospective create without publication", async () => {
  const vault = await fresh();
  const relative = "personal/notes/existing.md";
  assert.equal((await cli(vault, ["new", "note", "--personal", "--title", "Existing", "--description", "An existing topic"])).status, 0);
  const full = path.join(vault, relative);
  if (location === "body") fs.appendFileSync(full, Buffer.from([0xff]));
  else {
    const bytes = fs.readFileSync(full), offset = bytes.indexOf(Buffer.from("Existing"));
    assert.notEqual(offset, -1);
    fs.writeFileSync(full, Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xc3, 0x28]), bytes.subarray(offset)]));
  }
  const before = snapshot(vault);
  for (const args of [NEW, ["lint"], ["lint", relative], ["lint", "personal"], ["index"], ["index", "--check"]]) {
    const result = await cli(vault, args);
    assert.equal(result.status, args[0] === "new" ? 2 : 1, JSON.stringify(result));
    assert.equal(result.data.ok, false);
    assert.deepEqual(result.data.diagnostics, [{ path: relative, rule: "document.utf8", message: "Note is not valid UTF-8", fix: "Save the complete note as valid UTF-8 without replacing or discarding authored bytes" }]);
    assert.deepEqual(snapshot(vault), before);
  }
  const shown = await cli(vault, ["show", relative]);
  assert.equal(shown.status, 6);
  assert.equal(shown.data.error.code, "damaged");
  assert.deepEqual(snapshot(vault), before);
});

test("wiki:07 F3 strict inventory decoding preserves supported UTF-8 BOM bytes", async () => {
  const vault = await fresh();
  const relative = "personal/notes/existing.md";
  assert.equal((await cli(vault, ["new", "note", "--personal", "--title", "Existing", "--description", "An existing topic"])).status, 0);
  const full = path.join(vault, relative);
  fs.writeFileSync(full, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(full)]));
  const before = fs.readFileSync(full);
  assert.equal((await cli(vault, NEW)).status, 0);
  for (const args of [["lint"], ["lint", relative], ["index", "--check"]]) assert.equal((await cli(vault, args)).status, 0);
  const shown = await cli(vault, ["show", relative]);
  assert.equal(shown.status, 0);
  assert.equal(shown.data.markdown.charCodeAt(0), 0xfeff);
  assert.equal(shown.data.digest, digest(vault, relative));
  assert.deepEqual(fs.readFileSync(full), before);
});


for (const [command, args, relative] of [["new", NEW, "personal/notes/topic.md"], ["type add", ADD, ".wiki/types/glossary.json"]] as const) test("wiki:07 F2 preserves primary post-publication failure and digest when release also fails: " + command, async () => {
  const vault = await fresh();
  try {
    const result = await cli(vault, [...args], "post-publication");
    assert.notEqual(result.status, 0);
    assert.equal(result.data.error.code, "damaged");
    assert.match(result.data.error.message, /published.*navigation|published.*log/i);
    assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [relative]);
    assert.equal(result.data.digest, digest(vault, relative));
    assert.equal(result.data.cleanup.retained, true);
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), "");
  } finally { restore(vault); }
});

test("wiki:07 F2 index preserves primary I/O error and completed index digests when release also fails", async () => {
  const vault = await fresh();
  assert.equal((await cli(vault, NEW)).status, 0);
  try {
    const logBefore = fs.readFileSync(path.join(vault, "log.md"));
    const result = await cli(vault, ["index"], "partial-index");
    assert.notEqual(result.status, 0);
    assert.equal(result.data.error.code, "internal");
    assert.match(result.data.error.message, /EACCES.*personal\/index.md/);
    assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, ["index.md"]);
    assert.deepEqual(result.data.digests, { "index.md": digest(vault, "index.md") });
    assert.equal(result.data.cleanup.retained, true);
    assert.deepEqual(fs.readFileSync(path.join(vault, "log.md")), logBefore);
  } finally { restore(vault); }
});


for (const command of ["new", "index"]) test("wiki:07 F2 human output keeps the action outcome and lock-release failure without success: " + command, async () => {
  const vault = await fresh();
  try {
    let args = NEW, mode = "release-log";
    if (command === "index") {
      fs.mkdirSync(path.join(vault, "personal/notes"), { recursive: true });
      fs.writeFileSync(path.join(vault, "personal/notes/broken.md"), "---\ninvalid: [\n---\n");
      args = ["index"]; mode = "release-record";
    }
    const result = spawnCli(["--vault", vault, ...args], { imports: [GUARD], cwd: temp, env: { HOME: temp, WIKI_GUARD_VAULT: vault, WIKI_CLEANUP_MODE: mode } });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /lock.*release|release.*lock/i);
    if (command === "new") {
      assert.ok(result.stderr.includes("Written: personal/notes/topic.md"));
      assert.ok(result.stderr.includes(digest(vault, "personal/notes/topic.md")));
      assert.equal(result.stderr.includes("Created topic:"), false);
    } else assert.match(result.stderr, /personal\/notes\/broken.md: frontmatter.yaml:/);
  } finally { restore(vault); }
});
