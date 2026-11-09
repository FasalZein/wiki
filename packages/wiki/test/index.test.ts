import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, spawnJson } from "./cli-helper.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-index-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
// A Turkish locale proves index ordering does not follow the process locale; the locale applies at process start.
function cli(vault: string, ...args: string[]) { return spawnJson(["--vault", vault, ...args], { cwd: temp, env: { HOME: temp, LC_ALL: "tr_TR.UTF-8" } }); }
function fresh() {
  const vault = path.join(temp, String(++counter));
  assert.equal(cli(vault, "init").status, 0);
  return vault;
}
function write(vault: string, relative: string, bytes: string) {
  fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
  fs.writeFileSync(path.join(vault, relative), bytes);
}
function note(vault: string, relative: string, title: string, description = "A topic", type = "note", body = "Authored prose.\n") {
  write(vault, relative, '---\ntype: ' + type + '\ntitle: ' + JSON.stringify(title) + '\ndescription: ' + JSON.stringify(description) + '\ncreated: "2026-11-06T12:00:00Z"\n---\n' + body);
}
function read(vault: string, relative: string) { return fs.readFileSync(path.join(vault, relative), "utf8"); }
function succeeds(vault: string, ...args: string[]) {
  const result = cli(vault, ...args);
  assert.equal(result.status, 0, JSON.stringify(result));
  return result.data;
}
function snapshot(dir: string, ignoreLockActivity = false): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    // Rejected mutating index still acquires/releases its lock; retain all other metadata and lock contents.
    const lockDirectory = path.basename(dir) === ".wiki" && name === "locks";
    return [name, stat.mode, ignoreLockActivity && lockDirectory ? null : stat.mtimeMs, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isDirectory() ? snapshot(full, ignoreLockActivity) : fs.readFileSync(full).toString("base64")];
  });
}

test("wiki:05 exact scoped indexes have deterministic rows, escaped labels, recursive counts and no operational entries", () => {
  const vault = fresh();
  note(vault, "personal/notes/z-last.md", "A title", "Last path");
  note(vault, "personal/notes/a-first.md", "Z [title] *bold* <tag> & \\", "First path");
  note(vault, "personal/architecture/design.md", "Design", "Architecture", "architecture");
  note(vault, "projects/wiki/notes/topic.md", "Project");
  fs.mkdirSync(path.join(vault, "personal/procedures"));
  for (const relative of ["personal/assets/capture/source.md", "projects/wiki/assets/capture/source.md", ".obsidian/settings.md", "node_modules/foreign.md", ".wiki/ignored.md"]) write(vault, relative, "Not a concept\n");
  const authored = read(vault, "personal/notes/a-first.md");
  const result = succeeds(vault, "index");
  assert.deepEqual(result.paths, ["index.md", "personal/architecture/index.md", "personal/index.md", "personal/notes/index.md", "personal/procedures/index.md", "projects/index.md", "projects/wiki/index.md", "projects/wiki/notes/index.md"]);
  assert.equal(read(vault, "index.md"), '---\nokf_version: "0.2"\n---\n# Wiki\n\n* [personal](personal/index.md) - 3 concepts\n* [projects](projects/index.md) - 1 concept\n');
  assert.equal(read(vault, "personal/index.md"), '# personal\n\n* [architecture](architecture/index.md) - 1 concept\n* [notes](notes/index.md) - 2 concepts\n* [procedures](procedures/index.md) - 0 concepts\n');
  assert.equal(read(vault, "personal/notes/index.md"), '# notes\n\n* [Z \\[title\\] \\*bold\\* &lt;tag&gt; &amp; \\\\](a-first.md) - First path\n* [A title](z-last.md) - Last path\n');
  assert.equal(read(vault, "personal/procedures/index.md"), "# procedures\n");
  const first = result.paths.map((p: string) => read(vault, p));
  succeeds(vault, "index");
  assert.deepEqual(result.paths.map((p: string) => read(vault, p)), first);
  assert.equal(read(vault, "personal/notes/a-first.md"), authored);
  assert.equal(read(vault, "log.md"), "");
  const beforeChecks = snapshot(vault);
  succeeds(vault, "index", "--check");
  assert.ok(succeeds(vault, "lint").checks.includes("generated-index"));
  assert.ok(!succeeds(vault, "lint", "personal").checks.includes("generated-index"));
  assert.deepEqual(snapshot(vault), beforeChecks);
});


for (const mutation of ["description", "same-mtime", "rename", "delete", "missing-root", "missing-folder", "edited-row"]) test("wiki:05 current bytes detect " + mutation + " and checks are read-only until regeneration", () => {
  const vault = fresh(), relative = "personal/notes/topic.md";
  note(vault, relative, "Topic", "First description");
  fs.utimesSync(path.join(vault, relative), 1700000000, 1700000000);
  const git = spawnSync("git", ["init", "--quiet", vault], { encoding: "utf8", env: { ...process.env, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(git.status, 0, git.stderr);
  succeeds(vault, "index");
  const gitBefore = snapshot(path.join(vault, ".git")), logBefore = read(vault, "log.md");
  const full = path.join(vault, relative);
  if (mutation === "description" || mutation === "same-mtime") {
    const stat = fs.statSync(full);
    const bytes = read(vault, relative);
    fs.writeFileSync(full, bytes.replace("First description", "Other description"));
    if (mutation === "same-mtime") {
      fs.utimesSync(full, stat.atime, stat.mtime);
      assert.equal(fs.statSync(full).size, stat.size);
      assert.equal(fs.statSync(full).mtimeMs, stat.mtimeMs);
    }
  } else if (mutation === "rename") fs.renameSync(full, path.join(vault, "personal/notes/renamed.md"));
  else if (mutation === "delete") fs.unlinkSync(full);
  else if (mutation === "missing-root") fs.unlinkSync(path.join(vault, "index.md"));
  else if (mutation === "missing-folder") fs.unlinkSync(path.join(vault, "personal/notes/index.md"));
  else fs.appendFileSync(path.join(vault, "personal/notes/index.md"), "* edited generated row\n");
  const before = snapshot(vault);
  for (const args of [["index", "--check"], ["lint"]]) {
    const result = cli(vault, ...args);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.ok(result.data.diagnostics.some((d: { path: string; rule: string; message: string; fix: string }) => d.path.endsWith("index.md") && d.rule === (mutation.startsWith("missing") ? "index.missing" : "index.stale") && d.message && d.fix.includes("index")), JSON.stringify(result));
    assert.deepEqual(snapshot(vault), before);
  }
  succeeds(vault, "index");
  succeeds(vault, "index", "--check");
  succeeds(vault, "lint");
  assert.deepEqual(snapshot(path.join(vault, ".git")), gitBefore);
  assert.equal(read(vault, "log.md"), logBefore);
});

test("wiki:05 missing planned indexes can be repaired but missing authored notes and assets cannot", () => {
  const vault = fresh();
  note(vault, "personal/notes/topic.md", "Topic", "A topic", "note", "[parent](../index.md) [root](../../index.md) [folder](index.md)\n");
  fs.unlinkSync(path.join(vault, "index.md"));
  succeeds(vault, "index");
  fs.unlinkSync(path.join(vault, "personal/notes/index.md"));
  const beforeRepair = snapshot(vault);
  for (const selected of ["personal/notes/topic.md", "personal/notes"]) {
    const result = cli(vault, "lint", selected);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.ok(result.data.diagnostics.some((d: { path: string; rule: string }) => d.path === "personal/notes/topic.md" && d.rule === "link.missing"), JSON.stringify(result));
    assert.ok(!result.data.diagnostics.some((d: { rule: string }) => d.rule.startsWith("index.")), "Selected lint checks authored links, not whole-vault freshness");
    assert.deepEqual(snapshot(vault), beforeRepair);
  }
  for (const args of [["lint"], ["index", "--check"]]) {
    const result = cli(vault, ...args);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.ok(result.data.diagnostics.some((d: { path: string; rule: string }) => d.path === "personal/notes/index.md" && d.rule === "index.missing"), JSON.stringify(result));
    assert.deepEqual(snapshot(vault), beforeRepair);
  }
  succeeds(vault, "index");
  succeeds(vault, "lint", "personal/notes/topic.md");
  succeeds(vault, "lint", "personal/notes");
  for (const target of ["missing.md", "../assets/capture/missing.txt", "../unknown/index.md"]) {
    note(vault, "personal/notes/topic.md", "Topic", "A topic", "note", "[broken](" + target + ")\n");
    const before = snapshot(vault, true);
    for (const args of [["index"], ["index", "--check"], ["lint"], ["lint", "personal/notes/topic.md"], ["lint", "personal/notes"]]) {
      const result = cli(vault, ...args);
      assert.equal(result.status, 1, JSON.stringify(result));
      assert.ok(result.data.diagnostics.some((d: { rule: string }) => d.rule === "link.missing"));
      assert.deepEqual(snapshot(vault, true), before);
    }
  }
});

for (const invalid of ["yaml", "unknown", "title-newline", "description-newline", "heading", "layout"]) test("wiki:05 refuses invalid concepts without publishing: " + invalid, () => {
  const vault = fresh();
  note(vault, "personal/notes/topic.md", "Topic");
  succeeds(vault, "index");
  if (invalid === "yaml") write(vault, "personal/notes/topic.md", "---\ninvalid: [\n---\n");
  else if (invalid === "unknown") note(vault, "personal/notes/topic.md", "Topic", "A topic", "unknown");
  else if (invalid === "title-newline") note(vault, "personal/notes/topic.md", "Title\nInjected row");
  else if (invalid === "description-newline") note(vault, "personal/notes/topic.md", "Topic", "Description\r\nInjected row");
  else if (invalid === "heading") note(vault, "personal/procedures/run.md", "Run", "A procedure", "procedure");
  else note(vault, "personal/notes/deeper/topic.md", "Invalid placement");
  const before = snapshot(vault, true);
  for (const args of [["index"], ["index", "--check"], ["lint"]]) {
    const result = cli(vault, ...args);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.ok(result.data.diagnostics.length > 0);
    assert.deepEqual(snapshot(vault, true), before);
  }
});

for (const kind of ["symlink", "directory", "fifo"]) test("wiki:05 refuses unsafe generated destinations before overwriting any index: " + kind, () => {
  const vault = fresh();
  note(vault, "personal/notes/topic.md", "Topic");
  const sentinel = path.join(temp, "sentinel-" + counter);
  fs.writeFileSync(sentinel, "Outside sentinel\n");
  const target = path.join(vault, "personal/notes/index.md");
  if (kind === "symlink") fs.symlinkSync(sentinel, target);
  else if (kind === "directory") fs.mkdirSync(target);
  else assert.equal(spawnSync("mkfifo", [target]).status, 0);
  // A FIFO must never be opened by either validation or generation.
  const beforeRoot = read(vault, "index.md");
  for (const args of [["index"], ["index", "--check"], ["lint"]]) {
    const result = cli(vault, ...args);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.ok(result.data.diagnostics.some((d: { rule: string }) => d.rule === (kind === "symlink" ? "path.symlink" : "path.kind")), JSON.stringify(result));
    assert.equal(read(vault, "index.md"), beforeRoot);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "Outside sentinel\n");
  }
});

test("wiki:05 child directories sort by registered type before path and custom metadata stays one line", () => {
  const vault = fresh();
  succeeds(vault, "type", "add", "aaa", "--folder", "zzz");
  note(vault, "personal/zzz/topic.md", "Custom", "Tabs\tand Unicode\u2028spaces", "aaa");
  note(vault, "personal/architecture/design.md", "Design", "A topic", "architecture");
  succeeds(vault, "index");
  assert.equal(read(vault, "personal/index.md"), "# personal\n\n* [zzz](zzz/index.md) - 1 concept\n* [architecture](architecture/index.md) - 1 concept\n");
  assert.equal(read(vault, "personal/zzz/index.md"), "# zzz\n\n* [Custom](topic.md) - Tabs and Unicode spaces\n");
});


test("wiki:05 human index diagnostics identify path, rule and fix, and command grammar is strict", async () => {
  const vault = fresh();
  note(vault, "personal/notes/topic.md", "Topic");
  const human = (...args: string[]) => runCli(["--vault", vault, ...args]);
  const generated = await human("index");
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /^Generated navigation: index.md, personal\/index.md, personal\/notes\/index.md\n$/);
  const checked = await human("index", "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, "Generated indexes are current\n");
  fs.unlinkSync(path.join(vault, "personal/notes/index.md"));
  const before = snapshot(vault), missing = await human("index", "--check");
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /personal\/notes\/index.md: index.missing: Missing generated navigation index; fix: Run wiki --vault <dir> index/);
  for (const args of [["index", "personal"], ["lint", "--check"], ["type", "list", "--check"], ["index", "--folder", "notes"]]) {
    const result = cli(vault, ...args);
    assert.equal(result.status, 2, JSON.stringify(result));
    assert.equal(result.data.error.code, "usage");
  }
  assert.deepEqual(snapshot(vault), before);
});
