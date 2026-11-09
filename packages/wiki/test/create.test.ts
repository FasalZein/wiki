import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, runJson as cli, spawnJson } from "./cli-helper.ts";
import { fileURLToPath } from "node:url";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-create-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
async function fresh() {
  const vault = path.join(temp, String(++counter));
  assert.equal((await cli(vault, "init")).status, 0);
  return vault;
}
async function succeeds(vault: string, ...args: string[]) {
  const result = await cli(vault, ...args);
  assert.equal(result.status, 0, JSON.stringify(result));
  return result.data;
}
function read(vault: string, relative: string) { return fs.readFileSync(path.join(vault, relative), "utf8"); }
async function create(vault: string, title: string, ...args: string[]) {
  return await cli(vault, "new", "note", "--personal", "--title", title, "--description", "A topic", ...args);
}
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")];
  });
}

test("wiki:07 template create returns canonical metadata and digest, current indexes and one created log", async () => {
  const vault = await fresh();
  const result = await succeeds(vault, "new", "procedure", "--project", "wiki", "--title", "Run safely", "--description", "Use safe steps", "--tags", "local", "--tags", "cli", "--status", "draft");
  assert.equal(result.path, "projects/wiki/procedures/run-safely.md");
  assert.equal(result.title, "Run safely");
  assert.equal(result.description, "Use safe steps");
  const bytes = read(vault, result.path);
  assert.match(bytes, /created: "[0-9T:.Z-]+"/);
  assert.match(bytes, /## Steps/);
  assert.match(bytes, /status: "draft"/);
  assert.equal(result.digest, "sha256:" + createHash("sha256").update(bytes).digest("hex"));
  assert.equal(read(vault, "log.md").split("**created**").length - 1, 1);
  assert.ok(read(vault, "log.md").includes("[Run safely](projects/wiki/procedures/run-safely.md)"));
  await succeeds(vault, "lint");
  await succeeds(vault, "index", "--check");
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
});


function bodyFile(body: string) {
  const file = path.join(temp, "body-" + ++counter + ".md");
  fs.writeFileSync(file, body); return file;
}
async function rejectsUnchanged(vault: string, status: number, ...args: string[]) {
  const before = snapshot(vault), result = await cli(vault, ...args);
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.data.ok, false);
  assert.deepEqual(snapshot(vault), before);
  return result.data;
}

test("wiki:07 explicit inert body supports self and planned navigation links with safe YAML and Markdown labels", async () => {
  const vault = await fresh();
  const title = 'A [title] *bold* <tag> & "quote": yes';
  const description = 'A [description] <tag> & \\ literal';
  const body = '[self](topic.md) [fragment](#heading) [folder](index.md) [scope](../index.md) [root](../../index.md)\n\n~~~sh\n$(touch never) {{ literal }} <% literal %>\n~~~\n';
  const result = await succeeds(vault, "new", "note", "--personal", "--title", title, "--description", description, "--slug", "topic", "--body-file", bodyFile(body));
  const shown = await succeeds(vault, "show", result.path);
  assert.ok(shown.markdown.includes("title: " + JSON.stringify(title)));
  assert.ok(shown.markdown.includes("description: " + JSON.stringify(description)));
  assert.ok(read(vault, result.path).endsWith(body));
  const row = read(vault, "personal/notes/index.md");
  assert.ok(row.includes('A \\[title\\] \\*bold\\* &lt;tag&gt; &amp; "quote": yes'));
  assert.ok(read(vault, "log.md").includes('A \\[title\\] \\*bold\\* &lt;tag&gt; &amp; "quote": yes'));
  assert.equal(fs.existsSync(path.join(temp, "never")), false);
  await succeeds(vault, "lint");
  await succeeds(vault, "index", "--check");
});

test("wiki:07 seed templates and custom data types obey actual schema requirements", async () => {
  const vault = await fresh();
  for (const type of ["architecture", "decision", "procedure", "research", "reference", "note"]) {
    await succeeds(vault, "new", type, "--personal", "--title", type, "--description", "Seed template");
  }
  const source = await rejectsUnchanged(vault, 2, "new", "source", "--personal", "--title", "Source", "--description", "No invented provenance");
  assert.ok(source.diagnostics.some((d: { message: string }) => d.message.includes("resource")));
  assert.ok(source.diagnostics.some((d: { message: string }) => d.message.includes("retrieved")));
  await succeeds(vault, "type", "add", "glossary", "--folder", "glossary");
  const full = path.join(vault, ".wiki/types/glossary.json");
  const record = JSON.parse(fs.readFileSync(full, "utf8"));
  record.scopes = ["projects/wiki"];
  record.requiredHeadings = [{ level: 2, text: "Terms" }];
  record.template = "## Terms\n\n{{ inert }}\n";
  fs.writeFileSync(full, JSON.stringify(record));
  await rejectsUnchanged(vault, 2, "new", "glossary", "--personal", "--title", "Terms", "--description", "Wrong scope");
  await succeeds(vault, "new", "glossary", "--project", "wiki", "--title", "Terms", "--description", "Custom template");
  record.frontmatterSchema.properties.category = { type: "string" };
  record.frontmatterSchema.required.push("category");
  fs.writeFileSync(full, JSON.stringify(record));
  const missing = await rejectsUnchanged(vault, 2, "new", "glossary", "--project", "wiki", "--title", "More terms", "--description", "No invented category");
  assert.ok(missing.diagnostics.some((d: { message: string }) => d.message.includes("category")));
});

test("wiki:07 explicit scopes and slug derivation reject ambiguity and never suffix collisions", async () => {
  const vault = await fresh();
  for (const scope of [[], ["--personal", "--project", "wiki"], ["--project", "../escape"], ["--project", "assets"]]) {
    await rejectsUnchanged(vault, 2, "new", "note", ...scope, "--title", "Topic", "--description", "A topic");
  }
  await rejectsUnchanged(vault, 2, "new", "unknown", "--personal", "--title", "Topic", "--description", "A topic");
  assert.equal((await create(vault, "Café, déjà vu!")).data.path, "personal/notes/cafe-deja-vu.md");
  await rejectsUnchanged(vault, 3, "new", "note", "--personal", "--title", "Other title", "--description", "A topic", "--slug", "cafe-deja-vu");
  for (const slug of ["../bad", "Bad", "a_b", "index", "log", ""]) await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "Valid", "--description", "A topic", "--slug", slug);
  await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "知識", "--description", "A topic");
  assert.equal((await create(vault, "知識", "--slug", "knowledge")).status, 0);
  await succeeds(vault, "lint");
});

for (const [first, second] of [["Straße", " STRASSE "], ["Café", "Cafe\u0301"], ["ΟΣ", "οσ"]] as const) test("wiki:07 normalized scoped title collision preserves authored files: " + first, async () => {
  const vault = await fresh();
  assert.equal((await create(vault, first, "--slug", "first")).status, 0);
  await rejectsUnchanged(vault, 3, "new", "architecture", "--personal", "--title", second, "--description", "Duplicate", "--slug", "second");
  await succeeds(vault, "new", "note", "--project", "wiki", "--title", second, "--description", "Other scope", "--slug", "first");
  await succeeds(vault, "lint");
});

for (const [label, body] of [
  ["frontmatter", "---\ntitle: Injected\n---\nBody\n"],
  ["engine", "---js\nprocess.exit(99)\n---\n"],
  ["metadata", "Status: draft\n"], ["wikilink", "[[missing]]\n"],
  ["missing-note", "[missing](missing.md)\n"], ["missing-generated", "[missing](../unknown/index.md)\n"],
  ["escape", "[outside](../../../outside.md)\n"],
] as const) test("wiki:07 malformed or invalid body refuses before publication: " + label, async () => {
  const vault = await fresh();
  await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "Topic", "--description", "A topic", "--body-file", bodyFile(body));
});

test("wiki:07 malformed fields, missing headings and unrelated invalid concepts are not hidden by new indexes", async () => {
  const vault = await fresh();
  for (const [option, value] of [["--title", "bad\nline"], ["--description", ""], ["--status", "accepted"], ["--tags", "UPPER"]] as const) {
    await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "Topic", "--description", "A topic", option, value);
  }
  await rejectsUnchanged(vault, 2, "new", "procedure", "--personal", "--title", "Steps", "--description", "Missing heading", "--body-file", bodyFile("No steps\n"));
  assert.equal((await create(vault, "Old")).status, 0);
  fs.writeFileSync(path.join(vault, "personal/notes/old.md"), "---\ninvalid: [\n---\n");
  const result = await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "New", "--description", "A topic");
  assert.ok(result.diagnostics.some((d: { path: string; rule: string }) => d.path === "personal/notes/old.md" && d.rule === "frontmatter.yaml"));
});

test("wiki:07 held and stale locks refuse new, type add and index promptly without stealing", async () => {
  const vault = await fresh();
  const lock = path.join(vault, ".wiki/locks/mutation.lock");
  for (const owner of [{ token: "held", pid: process.pid }, { token: "stale", pid: 2147483647 }, {}]) {
    fs.writeFileSync(lock, JSON.stringify(owner));
    fs.utimesSync(lock, 0, 0);
    for (const args of [["new", "note", "--personal", "--title", "Topic", "--description", "A topic"], ["type", "add", "glossary", "--folder", "glossary"], ["index"]]) {
      const result = await rejectsUnchanged(vault, 3, ...args);
      assert.match(result.error.message, /lock busy/);
      assert.equal(fs.statSync(lock).mtimeMs, 0);
    }
    await succeeds(vault, "index", "--check");
    await succeeds(vault, "lint");
  }
  fs.unlinkSync(lock); // Explicit fixture operator recovery, never CLI recovery.
  assert.equal((await create(vault, "Topic")).status, 0);
});


// The create I/O guard patches fs per process, so guarded creates stay in a subprocess.
function guarded(vault: string, mode: string) {
  return spawnJson(["--vault", vault, "new", "note", "--personal", "--title", "Topic", "--description", "A topic"], {
    imports: [fileURLToPath(new URL("./create-io-guard.js", import.meta.url))], cwd: temp, timeout: 15000, env: { HOME: temp, WIKI_CREATE_GUARD: mode },
  });
}

test("wiki:07 exclusive complete-file publication preserves a destination created at the publication event", async () => {
  const vault = await fresh();
  const result = guarded(vault, "exclusive");
  assert.equal(result.status, 3, JSON.stringify(result));
  assert.equal(read(vault, "personal/notes/topic.md"), "External writer bytes\n");
  assert.equal(read(vault, "log.md"), "");
  assert.equal(read(vault, "index.md"), '---\nokf_version: "0.2"\n---\n# Wiki\n');
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
});

for (const mode of ["token", "replacement"]) test("wiki:07 release retains a lock whose ownership changed: " + mode, async () => {
  const vault = await fresh();
  const result = guarded(vault, mode);
  assert.equal(result.status, 0, JSON.stringify(result));
  const owner = JSON.parse(read(vault, ".wiki/locks/mutation.lock"));
  assert.equal(owner.token, mode === "token" ? "replacement-token" : "replacement-instance");
  await succeeds(vault, "lint");
});

test("wiki:07 post-note failure reports written path and current digest without success or fabricated log", async () => {
  const vault = await fresh();
  const result = guarded(vault, "partial");
  assert.notEqual(result.status, 0);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.written, true);
  assert.deepEqual(result.data.paths, ["personal/notes/topic.md"]);
  assert.equal(result.data.digest, "sha256:" + createHash("sha256").update(read(vault, "personal/notes/topic.md")).digest("hex"));
  assert.match(result.data.error.message, /run index.*inspect log.md/);
  assert.equal(read(vault, "log.md"), "");
  await succeeds(vault, "index");
  await succeeds(vault, "lint");
  assert.equal(read(vault, "log.md"), "");
});

test("wiki:07 create has no Git, model, qmd or global configuration effects", async () => {
  const vault = await fresh();
  const git = spawnSync("git", ["init", "--quiet", vault], { encoding: "utf8", env: { ...process.env, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(git.status, 0, git.stderr);
  const gitBefore = snapshot(path.join(vault, ".git"));
  const configBefore = read(vault, ".wiki/config.json");
  const registryBefore = snapshot(path.join(vault, ".wiki/types"));
  const homeBefore = fs.readdirSync(temp).sort();
  assert.equal((await create(vault, "Topic")).status, 0);
  assert.deepEqual(snapshot(path.join(vault, ".git")), gitBefore);
  assert.equal(read(vault, ".wiki/config.json"), configBefore);
  assert.deepEqual(snapshot(path.join(vault, ".wiki/types")), registryBefore);
  assert.deepEqual(fs.readdirSync(temp).sort(), homeBefore);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki")).sort(), ["config.json", "locks", "tmp", "types"]);
});


test("wiki:07 invalid UTF-8 body and unsafe write ancestors refuse without authored effects", async () => {
  const vault = await fresh();
  const invalid = path.join(temp, "invalid-utf8.md");
  fs.writeFileSync(invalid, Buffer.from([0xff, 0xfe]));
  await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "Topic", "--description", "A topic", "--body-file", invalid);
  const outside = fs.mkdtempSync(path.join(temp, "outside-"));
  fs.symlinkSync(outside, path.join(vault, "personal"));
  await rejectsUnchanged(vault, 2, "new", "note", "--personal", "--title", "Topic", "--description", "A topic");
  assert.deepEqual(fs.readdirSync(outside), []);
});


test("wiki:07 human create output includes canonical identity, title, description and full digest", async () => {
  const vault = await fresh();
  const result = await runCli(["--vault", vault, "new", "note", "--personal", "--title", "Human topic", "--description", "Human description"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Created topic: personal/notes/human-topic.md\nTitle: Human topic\nDescription: Human description\nsha256:" + createHash("sha256").update(read(vault, "personal/notes/human-topic.md")).digest("hex") + "\n");
});


test("wiki:07 sequential creates retain one line per mutation under one UTC log heading", async () => {
  const vault = await fresh();
  assert.equal((await create(vault, "First")).status, 0);
  assert.equal((await create(vault, "Second")).status, 0);
  const log = read(vault, "log.md");
  assert.equal(log.split("**created**").length - 1, 2);
  assert.equal(log.split("## ").length - 1, 1);
  assert.ok(log.indexOf("[Second]") < log.indexOf("[First]"));
  await succeeds(vault, "lint");
  await succeeds(vault, "index", "--check");
});
