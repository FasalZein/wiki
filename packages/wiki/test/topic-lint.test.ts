import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, runJson as cli } from "./cli-helper.ts";
import { checkVault, navigationIndexes, selectedDiagnostics } from "../src/lint.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-topic-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
async function indexedLint(vault: string) {
  const generated = await cli(vault, "index");
  assert.equal(generated.status, 0, JSON.stringify(generated));
  return await cli(vault, "lint");
}
async function fresh() {
  const vault = path.join(temp, String(++counter));
  assert.equal((await cli(vault, "init")).status, 0);
  return vault;
}
function note(vault: string, relative = "personal/notes/topic.md", fields = "", body = "Authored prose.\n", type = "note", title = "Topic") {
  fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
  fs.writeFileSync(path.join(vault, relative), '---\ntype: ' + type + '\ntitle: ' + JSON.stringify(title) + '\ndescription: A topic\ncreated: "2026-11-06T12:00:00Z"\n' + fields + '---\n' + body);
  return relative;
}
async function rejects(vault: string, relative: string, rule: string, ...args: string[]) {
  const result = await cli(vault, "lint", ...args);
  assert.equal(result.status, 1, JSON.stringify(result));
  assert.ok(result.data.diagnostics.some((d: { path: string; rule: string; fix: string }) => d.path === relative && d.rule === rule && d.fix.length > 0), JSON.stringify(result));
  return result;
}

test("wiki:03 selected inventory hides unrelated diagnostics but never renders a partial index", async () => {
  const vault = await fresh();
  const selected = note(vault, "personal/notes/selected.md", "", "", "note", "Selected");
  const other = note(vault, "projects/wiki/notes/other.md", "status: deprecated\nsuperseded_by: missing.md\n", "", "note", "Other");
  const inventory = checkVault(vault);
  assert.deepEqual(selectedDiagnostics(inventory, selected), []);
  assert.equal(navigationIndexes(inventory).size, 0, "an invalid unselected topic blocks all planned navigation");
  assert.deepEqual(inventory.diagnostics.map(d => [d.path, d.rule]), [[other, "lifecycle.target"]]);
  fs.unlinkSync(path.join(vault, other));
  const repaired = checkVault(vault);
  assert.deepEqual(selectedDiagnostics(repaired, selected), []);
  assert.match(navigationIndexes(repaired).get("personal/notes/index.md")!, /Selected/);
  assert.ok(navigationIndexes(repaired).has("index.md"));
});

test("wiki:03 canonical placement requires scope, registered folder, safe project and exact slug depth", async () => {
  const vault = await fresh();
  for (const relative of ["topic.md", "notes/topic.md", "personal/topic.md", "personal/decisions/topic.md", "personal/notes/deeper/topic.md", "personal/notes/deeper/index.md", "personal/unknown/index.md", "personal/notes/Bad.md", "personal/notes/index-name!.md", "projects/Bad/notes/topic.md", "projects/assets/notes/topic.md"]) {
    note(vault, relative);
    await rejects(vault, relative, "path.layout");
    fs.unlinkSync(path.join(vault, relative));
  }
  note(vault);
  note(vault, "projects/wiki/notes/topic.md");
  assert.equal((await indexedLint(vault)).status, 0);
});


test("wiki:03 required headings are authored Markdown, including decision parent hierarchy", async () => {
  const vault = await fresh();
  const relative = "personal/procedures/run.md";
  for (const body of ["No heading\n", "~~~md\n## Steps\n~~~\n", "    ## Steps\n", "> ## Steps\n", "\x60## Steps\x60\n", "## \x60Steps\x60\n", "<pre>\n## Steps\n</pre>\n"]) {
    note(vault, relative, "", body, "procedure");
    await rejects(vault, relative, "body.heading");
  }
  for (const body of ["## Steps\n", "Steps\n-----\n", "## **Steps** ##\n"]) {
    note(vault, relative, "", body, "procedure");
    assert.equal((await indexedLint(vault)).status, 0, body);
  }
  fs.unlinkSync(path.join(vault, relative));
  const decision = "personal/decisions/choice.md";
  const prefix = "## Context and Problem Statement\n\n## Considered Options\n\n";
  for (const body of [prefix + "### Consequences\n\n## Decision Outcome\n", prefix + "## Decision Outcome\n\n## Other\n\n### Consequences\n", prefix + "## Decision Outcome\n\n#### Consequences\n", prefix + "## Decision Outcome\n\n# Decision Outcome\n\n### Consequences\n"]) {
    note(vault, decision, "status: draft\n", body, "decision");
    await rejects(vault, decision, "body.heading");
  }
  note(vault, decision, "status: stable\n", prefix + "## Decision Outcome\n\n### Consequences\n", "decision");
  assert.equal((await indexedLint(vault)).status, 0);
});

test("wiki:03 metadata repetition is rejected but prose and literal examples remain authored bytes", async () => {
  const vault = await fresh();
  for (const body of ["Status: stable\n", "Type: note\n", "Intro.\nStatus: draft\n", "**Status:** stable\n", "- Type: note\n"]) {
    const relative = note(vault, undefined, "", body);
    await rejects(vault, relative, "body.metadata");
  }
  note(vault, undefined, "", "The Status: value is optional. Type: is a label in this sentence.\n\n~~~md\nStatus: draft\nType: note\n## Steps\necho ${USER}\n~~~\n\n> Status: draft\n> Type: note\n\n\x60Status: stable\x60\n\n    Type: note\n\n<pre>\nStatus: stable\n</pre>\n");
  assert.equal((await indexedLint(vault)).status, 0);
});


test("wiki:03 duplicate titles use trimmed case normalization within scope, including selected-path context", async () => {
  const vault = await fresh();
  const first = note(vault, "personal/notes/first.md", "", "", "note", " Shared Title ");
  const second = note(vault, "personal/architecture/second.md", "", "", "architecture", "shared title");
  const other = note(vault, "projects/wiki/notes/other.md", "", "", "note", "SHARED TITLE");
  for (const selected of [[], [first], ["personal/notes"]]) {
    const result = await rejects(vault, first, "title.duplicate", ...selected);
    assert.deepEqual(result.data.diagnostics.filter((d: { rule: string }) => d.rule === "title.duplicate").map((d: { path: string }) => d.path), [second, first]);
  }
  assert.equal((await cli(vault, "lint", other)).status, 0, "another scope has no duplicate");
  fs.unlinkSync(path.join(vault, second));
  assert.equal((await indexedLint(vault)).status, 0, "same title in another scope is valid");
});

test("wiki:03 lifecycle dependencies cannot be removed by custom schemas and targets must be canonical topics", async () => {
  const vault = await fresh();
  const registry = path.join(vault, ".wiki/types/note.json");
  const record = JSON.parse(fs.readFileSync(registry, "utf8"));
  record.frontmatterSchema = true;
  fs.writeFileSync(registry, JSON.stringify(record));
  const target = note(vault, "projects/wiki/notes/replacement.md", "", "", "note", "Replacement");
  const relative = "personal/notes/topic.md";
  for (const fields of ["superseded_by: " + target + "\n", "status: stable\nsuperseded_by: " + target + "\n", "status: draft\nsuperseded_by: " + target + "\n"]) {
    note(vault, relative, fields);
    await rejects(vault, relative, "frontmatter.schema");
  }
  for (const invalid of ["missing.md", "personal/notes/missing.md", "/" + target, "../" + target, "projects/wiki/notes/../notes/replacement.md", "projects/wiki/notes/replacement", "index.md", "log.md", ".wiki/types/note.json", "personal/notes/Bad.md"]) {
    note(vault, relative, "status: deprecated\nsuperseded_by: " + invalid + "\n");
    await rejects(vault, relative, "lifecycle.target", relative);
  }
  for (const fields of ["", "status: draft\n", "status: stable\n", "status: deprecated\n", "status: deprecated\nsuperseded_by: " + target + "\n"]) {
    note(vault, relative, fields);
    assert.equal((await indexedLint(vault)).status, 0, fields);
  }
});

test("wiki:03 whole-vault lint applies registry edits to existing notes and templates use real headings", async () => {
  const vault = await fresh();
  assert.equal((await cli(vault, "type", "add", "glossary", "--folder", "glossary")).status, 0);
  const relative = note(vault, "personal/glossary/terms.md", "", "## Terms\n", "glossary");
  assert.equal((await indexedLint(vault)).status, 0);
  const registry = path.join(vault, ".wiki/types/glossary.json");
  const record = JSON.parse(fs.readFileSync(registry, "utf8"));
  record.frontmatterSchema.required.push("category");
  record.frontmatterSchema.properties.category = { type: "string" };
  record.requiredHeadings = [{ level: 2, text: "Terms" }];
  record.template = "~~~md\n## Terms\n~~~\n";
  fs.writeFileSync(registry, JSON.stringify(record));
  await rejects(vault, ".wiki/types/glossary.json", "registry.template", relative);
  record.template = "Terms\n-----\n";
  fs.writeFileSync(registry, JSON.stringify(record));
  await rejects(vault, relative, "frontmatter.schema");
  note(vault, relative, "category: engineering\n", "## Terms\n", "glossary");
  assert.equal((await indexedLint(vault)).status, 0);
  record.folder = "terminology";
  fs.writeFileSync(registry, JSON.stringify(record));
  await rejects(vault, relative, "path.layout");
});


test("wiki:03 lint is read-only across success, failure, path selection, registry changes, and Git state", async () => {
  const vault = await fresh();
  const git = spawnSync("git", ["init", "--quiet", vault], { encoding: "utf8", env: { ...process.env, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(git.status, 0, git.stderr);
  const relative = note(vault);
  fs.mkdirSync(path.join(vault, "personal/assets/example"), { recursive: true });
  fs.writeFileSync(path.join(vault, "personal/assets/example/source.md"), "Literal source, not a concept.");
  function snapshot(dir: string): unknown[] {
    return fs.readdirSync(dir).sort().map(name => {
      const full = path.join(dir, name), stat = fs.lstatSync(full);
      return [name, stat.mode, stat.mtimeMs, stat.isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")];
    });
  }
  assert.equal((await cli(vault, "index")).status, 0);
  let before = snapshot(vault);
  const success = await cli(vault, "lint");
  assert.equal(success.status, 0);
  assert.deepEqual(success.data.checks, ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", "generated-index"]);
  assert.equal((await cli(vault, "lint", relative)).status, 0);
  assert.deepEqual(snapshot(vault), before);
  note(vault, relative, "", "Status: stable\n");
  before = snapshot(vault);
  const failed = await rejects(vault, relative, "body.metadata");
  assert.deepEqual(await cli(vault, "lint"), failed, "diagnostics are deterministic");
  await rejects(vault, relative, "body.metadata", relative);
  assert.deepEqual(snapshot(vault), before);
  fs.writeFileSync(path.join(vault, ".wiki/types/note.json"), "{");
  before = snapshot(vault);
  await rejects(vault, ".wiki/types/note.json", "registry.json", relative);
  assert.deepEqual(snapshot(vault), before);
  const help = await runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Whole-vault lint checks .*generated-index freshness/);
});


for (const mode of ["whole-vault", "selected-file", "selected-directory"]) test("wiki:03 only canonical scope capture assets are excluded: " + mode, async () => {
  const vault = await fresh();
  for (const relative of ["personal/notes/assets/topic.md", "projects/wiki/notes/assets/topic.md", "assets/topic.md", "projects/Bad/assets/topic.md"]) {
    note(vault, relative);
    const selected = mode === "whole-vault" ? [] : [mode === "selected-file" ? relative : path.posix.dirname(relative)];
    await rejects(vault, relative, "path.layout", ...selected);
    fs.unlinkSync(path.join(vault, relative));
  }
  for (const relative of ["personal/assets/capture/source.md", "projects/wiki/assets/capture/source.md"]) {
    fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
    fs.writeFileSync(path.join(vault, relative), "Literal capture without frontmatter.\nStatus: source text\n");
  }
  assert.equal((await indexedLint(vault)).status, 0);
  assert.equal((await cli(vault, "lint", "personal")).status, 0);
  assert.equal((await cli(vault, "lint", "projects/wiki")).status, 0);
});


for (const [left, right] of [["Straße", "STRASSE"], ["ΟΣ", "οσ"]]) for (const mode of ["whole-vault", "selected-path"]) {
  test("wiki:03 Unicode case-fold duplicates " + left + "/" + right + ": " + mode, async () => {
    const vault = await fresh();
    const first = note(vault, "personal/notes/one.md", "", "", "note", " " + left + " ");
    const second = note(vault, "personal/notes/two.md", "", "", "note", right);
    const other = note(vault, "projects/wiki/notes/other.md", "", "", "note", right);
    const before = [first, second, other].map(file => fs.readFileSync(path.join(vault, file), "utf8"));
    const selected = mode === "whole-vault" ? [] : [first];
    const result = await rejects(vault, first, "title.duplicate", ...selected);
    assert.deepEqual(result.data.diagnostics.map((d: { path: string; rule: string }) => [d.path, d.rule]), [[first, "title.duplicate"], [second, "title.duplicate"]]);
    assert.deepEqual([first, second, other].map(file => fs.readFileSync(path.join(vault, file), "utf8")), before, "folding never rewrites authored titles");
    assert.equal((await cli(vault, "lint", other)).status, 0);
    fs.unlinkSync(path.join(vault, second));
    assert.equal((await cli(vault, "index")).status, 0);
    assert.equal((await cli(vault, "lint", ...selected)).status, 0, "case-fold equivalents in different scopes are allowed");
    assert.equal((await indexedLint(vault)).status, 0);
  });
}


test("wiki:03 default case folding preserves accents and does not use Turkic locale tailoring", async () => {
  const vault = await fresh();
  for (const [slug, title] of [["accented", "café"], ["plain", "cafe"], ["dotted", "İ"], ["undotted", "i"]]) note(vault, "personal/notes/" + slug + ".md", "", "", "note", title);
  assert.equal((await indexedLint(vault)).status, 0);
  assert.equal((await cli(vault, "lint", "personal/notes/dotted.md")).status, 0);
});
