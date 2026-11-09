// In-process rule tests: inventories built from strings, validated against the seed registry.
// The CLI tests cover the same rules through the process; these cover the scan, validate and render seams.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { parseNote, withNote, type Inventory } from "../src/inventory.ts";
import { navigationIndexes, searchConcepts, validateInventory } from "../src/lint.ts";
import { loadRegistry } from "../src/registry.ts";
import { initVault } from "../src/vault.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-inventory-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
// The vault supplies only the compiled seed registry and an empty root for link-target checks.
const root = initVault(path.join(temp, "vault")).root;
const registry = loadRegistry(root);

const topic = (title: string, extra = "", body = "# " + title + "\n") =>
  "---\ntype: note\ntitle: " + JSON.stringify(title) + "\ndescription: A topic\ncreated: \"2026-11-09T12:00:00Z\"\n" + extra + "---\n" + body;
function inventory(notes: Record<string, string>, more: Partial<Inventory> = {}): Inventory {
  const directories = new Set([""]);
  for (const file of Object.keys(notes)) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  return { root, directories: [...directories], indexFiles: [], notes: Object.entries(notes).map(([file, markdown]) => parseNote(file, markdown)), problems: [], ...more };
}
/** Distinct (path, rule) pairs in diagnostic order. */
const rules = (inv: Inventory) => [...new Set(validateInventory(inv, registry).diagnostics.map(d => d.path + " " + d.rule))].map(pair => pair.split(" "));

test("a clean inventory has no diagnostics, renders every maintained index, and yields every canonical concept", () => {
  const validated = validateInventory(inventory({ "personal/notes/a.md": topic("A"), "projects/wiki/notes/b.md": topic("B") }), registry);
  assert.deepEqual(validated.diagnostics, []);
  assert.deepEqual([...navigationIndexes(validated).keys()].sort(), ["index.md", "personal/index.md", "personal/notes/index.md", "projects/index.md", "projects/wiki/index.md", "projects/wiki/notes/index.md"]);
  assert.match(navigationIndexes(validated).get("personal/notes/index.md")!, /\[A\]\(a\.md\) - A topic/);
  assert.deepEqual(searchConcepts(validated).map(c => c.path), ["personal/notes/a.md", "projects/wiki/notes/b.md"]);
});

test("frontmatter rules: unparsable YAML, unknown type, undeclared and nested properties", () => {
  assert.deepEqual(rules(inventory({
    "personal/notes/yaml.md": "---\ntags: [broken\n---\n",
    "personal/notes/unknown.md": topic("U").replace("type: note", "type: nosuch"),
    "personal/notes/extra.md": topic("E", "colour: blue\n"),
    "personal/notes/nested.md": topic("N", "tags:\n  - a\n  - b: c\n"),
  })), [
    // The seed schemas also refuse additional properties.
    ["personal/notes/extra.md", "frontmatter.declared"],
    ["personal/notes/extra.md", "frontmatter.schema"],
    ["personal/notes/nested.md", "frontmatter.flat"],
    ["personal/notes/nested.md", "frontmatter.schema"],
    ["personal/notes/unknown.md", "frontmatter.type"],
    ["personal/notes/yaml.md", "frontmatter.yaml"],
  ]);
});

test("layout rules: a note outside its registered folder and an index outside a maintained directory", () => {
  assert.deepEqual(rules(inventory({ "personal/misc/a.md": topic("A") }, { indexFiles: ["personal/misc/index.md"] })), [
    ["personal/misc/a.md", "path.layout"],
    ["personal/misc/index.md", "path.layout"],
  ]);
});

test("body metadata, lifecycle target and scoped duplicate titles are reported per note", () => {
  const validated = validateInventory(inventory({
    "personal/notes/meta.md": topic("Meta", "", "# Meta\n\nStatus: draft\n"),
    "personal/notes/old.md": topic("Old", "status: deprecated\nsuperseded_by: personal/notes/none.md\n"),
    "personal/notes/upper.md": topic("STRASSE"),
    "personal/notes/lower.md": topic("Straße"),
    // The same title in another scope is not a duplicate.
    "projects/wiki/notes/lower.md": topic("Straße"),
  }), registry);
  assert.deepEqual(validated.diagnostics.map(d => [d.path, d.rule]), [
    ["personal/notes/lower.md", "title.duplicate"],
    ["personal/notes/meta.md", "body.metadata"],
    ["personal/notes/old.md", "lifecycle.target"],
    ["personal/notes/upper.md", "title.duplicate"],
  ]);
  // The group lists its members in scan order.
  assert.equal(validated.diagnostics[0]!.message, "Duplicate title in personal: personal/notes/upper.md, personal/notes/lower.md");
  assert.equal(navigationIndexes(validated).size, 0, "any diagnostic blocks all planned navigation");
});

test("a pending note replaces the old note and its problem, or is added with its parent directories", () => {
  const base = inventory({ "personal/notes/a.md": "---\ntags: [broken\n---\n" });
  assert.deepEqual(rules(base), [["personal/notes/a.md", "frontmatter.yaml"]]);
  const replaced = validateInventory(withNote(base, { path: "personal/notes/a.md", markdown: topic("A") }), registry);
  assert.deepEqual(replaced.diagnostics, []);
  assert.equal(replaced.notes.length, 1);
  const added = withNote(inventory({}), { path: "projects/new/notes/b.md", markdown: topic("B") });
  assert.deepEqual(added.directories, ["", "projects", "projects/new", "projects/new/notes"]);
  assert.ok(navigationIndexes(validateInventory(added, registry)).has("projects/new/notes/index.md"));
});

test("a pending note may link to the indexes its publication will generate", () => {
  const pending = withNote(inventory({}), { path: "personal/notes/a.md", markdown: topic("A", "", "# A\n\n[Notes](index.md)\n") });
  assert.deepEqual(validateInventory(pending, registry).diagnostics, []);
  // Selected-path lint requires link targets that exist now; the index does not exist in this vault.
  assert.deepEqual(validateInventory(pending, registry, { existingLinkTargets: true }).diagnostics.map(d => d.rule), ["link.missing"]);
});

test("search concepts exclude notes with diagnostics, notes under a diagnosed directory, and everything when the root is diagnosed", () => {
  const notes = { "personal/notes/good.md": topic("Good"), "personal/notes/bad.md": topic("Bad", "colour: blue\n"), "projects/wiki/notes/c.md": topic("C") };
  const problem = (at: string) => ({ path: at, rule: "path.unreadable", message: "unreadable", fix: "restore" });
  assert.deepEqual(searchConcepts(validateInventory(inventory(notes), registry)).map(c => c.path), ["personal/notes/good.md", "projects/wiki/notes/c.md"]);
  assert.deepEqual(searchConcepts(validateInventory(inventory(notes, { problems: [problem("projects/wiki")] }), registry)).map(c => c.path), ["personal/notes/good.md"]);
  assert.deepEqual(searchConcepts(validateInventory(inventory(notes, { problems: [problem("")] }), registry)), []);
});
