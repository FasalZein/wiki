import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-registry-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function cli(vault: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [BIN, "--json", "--vault", vault, ...args], {
    encoding: "utf8", cwd: temp, env: { ...process.env, HOME: temp, WIKI_VAULT: "" },
  });
  assert.equal(result.stderr, "");
  return { status: result.status, data: JSON.parse(result.stdout) };
}
function fresh() {
  const vault = path.join(temp, String(++counter));
  assert.equal(cli(vault, "init").status, 0);
  return vault;
}
function record(vault: string, name = "note") {
  return JSON.parse(fs.readFileSync(path.join(vault, ".wiki/types", name + ".json"), "utf8"));
}
function save(vault: string, name: string, data: unknown) {
  fs.writeFileSync(path.join(vault, ".wiki/types", name + ".json"), JSON.stringify(data));
}
const valid = `---
type: glossary
title: Terms
description: Local terms
created: "2026-11-06T12:00:00Z"
category: engineering
---
# Terms
`;
function note(vault: string, text = valid, relative = "projects/wiki/glossary/terms.md") {
  fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
  fs.writeFileSync(path.join(vault, relative), text);
  return relative;
}
function diagnostic(vault: string, rule: string, file: string, message: RegExp) {
  const result = cli(vault, "lint");
  assert.equal(result.status, 1, JSON.stringify(result.data));
  assert.equal(result.data.error.code, "lint");
  const found = result.data.diagnostics.find((d: {rule: string; path: string; message: string}) => d.rule === rule && d.path === file && message.test(d.message));
  assert.ok(found, JSON.stringify(result.data));
  assert.match(found.message, message);
  assert.equal(typeof found.fix, "string");
  assert.ok(found.fix.length > 0);
  assert.deepEqual(cli(vault, "lint"), result, "diagnostics are deterministic");
}

test("okf:02 real init/list/add/custom-schema/lint flow accepts an eighth data-defined type", () => {
  const vault = fresh();
  const list = cli(vault, "type", "list");
  assert.equal(list.status, 0);
  assert.equal(list.data.types.length, 7);
  const decision = list.data.types.find((t: { name: string }) => t.name === "decision");
  assert.equal(decision.folder, "decisions");
  assert.deepEqual(decision.requiredFields, ["type", "title", "description", "created"]);
  assert.deepEqual(decision.requiredHeadings.at(-1), { level: 3, text: "Consequences" });
  assert.equal(cli(vault, "type", "add", "glossary", "--folder", "glossary").status, 0);
  const scaffold = record(vault, "glossary");
  scaffold.scopes = ["projects/wiki"];
  scaffold.frontmatterSchema.$defs = { category: { type: "string", enum: ["engineering", "personal"] } };
  scaffold.frontmatterSchema.properties.category = { $ref: "#/$defs/category" };
  scaffold.frontmatterSchema.required.push("category");
  save(vault, "glossary", scaffold);
  const relative = note(vault);
  const lint = cli(vault, "lint");
  assert.equal(lint.status, 0, JSON.stringify(lint.data));
  const eighth = cli(vault, "type", "list").data.types.find((t: { name: string }) => t.name === "glossary");
  assert.deepEqual(eighth.scopes, ["projects/wiki"]);
  assert.ok(eighth.requiredFields.includes("category"));
  const before = fs.readFileSync(path.join(vault, ".wiki/types/glossary.json"), "utf8");
  assert.equal(cli(vault, "type", "add", "glossary", "--folder", "glossary").status, 3);
  assert.equal(fs.readFileSync(path.join(vault, ".wiki/types/glossary.json"), "utf8"), before);
  note(vault, valid.replace("category: engineering", "category: invalid"));
  diagnostic(vault, "frontmatter.schema", relative, /category.*allowed|allowed.*category/);
  note(vault, valid.replace("category: engineering\n", ""));
  diagnostic(vault, "frontmatter.schema", relative, /category/);
});

test("okf:02 literal fenced shell placeholders remain inert template body data", () => {
  const vault = fresh();
  const procedure = record(vault, "procedure");
  procedure.template = ['## Steps', '', '~~~sh', 'echo "$' + '{USER}"', '{{ literal }}', '<% literal %>', '~~~', ''].join("\n");
  save(vault, "procedure", procedure);
  const before = fs.readFileSync(path.join(vault, ".wiki/types/procedure.json"), "utf8");
  const results = [["lint"], ["type", "list"]].map(args => cli(vault, ...args));
  assert.deepEqual(results.map(result => result.status), [0, 0], JSON.stringify(results));
  assert.equal(fs.readFileSync(path.join(vault, ".wiki/types/procedure.json"), "utf8"), before);
});

test("okf:02 Markdown thematic breaks and fenced frontmatter examples are literal template bodies", () => {
  const vault = fresh();
  for (const template of [
    "Introductory prose\n\n---\n\nMore prose\n",
    "---\n\nA leading thematic break, not a frontmatter block.\n",
    "~~~yaml\n---\ntitle: Example\n---\n~~~\n",
  ]) {
    const architecture = record(vault, "architecture"); architecture.template = template;
    save(vault, "architecture", architecture);
    const results = [["lint"], ["type", "list"]].map(args => cli(vault, ...args));
    assert.deepEqual(results.map(result => result.status), [0, 0], JSON.stringify(results));
    assert.equal(record(vault, "architecture").template, template);
  }
});

test("okf:02 registry errors name independent causes without rewriting input", () => {
  const cases: { rule: string; change: (r: ReturnType<typeof record>) => void; message: RegExp }[] = [
    { rule: "registry.schema", change: r => { r.frontmatterSchema = { type: "not-a-schema-type" }; }, message: /schema.*invalid|invalid.*schema/i },
    { rule: "registry.schema", change: r => { r.frontmatterSchema.$async = true; }, message: /async|executable/i },
    { rule: "registry.schema", change: r => { r.frontmatterSchema.properties.title = { $ref: "https://example.invalid/schema" }; }, message: /local fragment/ },
    { rule: "registry.schema", change: r => { r.frontmatterSchema.$defs = { bad: { $dynamicRef: "https://example.invalid/schema" } }; }, message: /local fragment/ },
    { rule: "registry.schema", change: r => { r.frontmatterSchema.properties.title = { $ref: "#/$defs/missing" }; }, message: /resolve reference/ },
    { rule: "registry.schema", change: r => { r.frontmatterSchema.$schema = "http://json-schema.org/draft-07/schema#"; }, message: /2020-12/ },
    { rule: "registry.folder", change: r => { r.folder = "../outside"; }, message: /unsafe|reserved/i },
    { rule: "registry.folder", change: r => { r.folder = "assets"; }, message: /reserved/i },
    { rule: "registry.folder", change: r => { r.folder = "decisions"; }, message: /conflict/i },
    { rule: "registry.record", change: r => { r.scopes = ["projects/*"]; }, message: /pattern/ },
    { rule: "registry.name", change: r => { r.name = "different"; }, message: /filename.*name/i },
    // Engine configuration is prohibited; placeholder-looking body strings are not executable.
    { rule: "registry.record", change: r => { r.templateEngine = "javascript"; }, message: /additional properties/i },
    { rule: "registry.template", change: r => { r.template = "---\ntitle: Not a body\n---\nText\n"; }, message: /leading frontmatter/i },
    { rule: "registry.template", change: r => { r.template = "\uFEFF---\r\ntitle: Not a body\r\n---\r\nText\r\n"; }, message: /leading frontmatter/i },
    { rule: "registry.template", change: r => { r.template = "---js\nprocess.exit(99)\n---\n"; }, message: /leading frontmatter/i },
    { rule: "registry.template", change: r => { r.requiredHeadings = [{ level: 2, text: "Required" }]; }, message: /missing.*heading/i },
  ];
  for (const c of cases) {
    const vault = fresh();
    const data = record(vault);
    c.change(data);
    save(vault, "note", data);
    const before = fs.readFileSync(path.join(vault, ".wiki/types/note.json"), "utf8");
    diagnostic(vault, c.rule, ".wiki/types/note.json", c.message);
    assert.equal(fs.readFileSync(path.join(vault, ".wiki/types/note.json"), "utf8"), before);
  }
  const vault = fresh();
  fs.writeFileSync(path.join(vault, ".wiki/types/note.json"), "{");
  diagnostic(vault, "registry.json", ".wiki/types/note.json", /malformed JSON/i);
});

test("okf:02 common profile stays mandatory with a permissive custom schema", () => {
  const invalid = [
    ["title: Terms\n", "", /title/],
    ["description: Local terms\n", "", /description/],
    ['created: "2026-11-06T12:00:00Z"', "created: 2026-11-06", /created/],
    ['created: "2026-11-06T12:00:00Z"', "created: 2026-11-06T12:00:00", /created/],
    ['created: "2026-11-06T12:00:00Z"', "created: 2026-02-30T12:00:00Z", /created/],
    ["title: Terms", "title: 42", /title/],
    ["title: Terms", 'title: " "', /title/],
    ["title: Terms", 'title: "line\\nline"', /title/],
    ["category: engineering", "tags: [UPPER]", /tags/],
    ["category: engineering", "tags: [É]", /tags/],
    ["category: engineering", "status: accepted", /status/],
    ["category: engineering", "id: forbidden", /id/],
    ['created: "2026-11-06T12:00:00Z"\n', "", /created/],
    ["category: engineering", "updated: forbidden", /updated/],
  ] as const;
  for (const [from, to, expected] of invalid) {
    const vault = fresh();
    const custom = record(vault);
    custom.name = "glossary"; custom.folder = "glossary"; custom.frontmatterSchema = true;
    save(vault, "glossary", custom);
    const relative = note(vault, valid.replace(from, to));
    diagnostic(vault, "frontmatter.schema", relative, expected);
  }
});

test("okf:02 rejects unknown types, undeclared fields, nested data, unsafe YAML, and scope mismatch", () => {
  const vault = fresh();
  const custom = record(vault);
  custom.name = "glossary"; custom.folder = "glossary";
  custom.frontmatterSchema.properties.type.const = "glossary";
  custom.scopes = ["personal"];
  save(vault, "glossary", custom);
  const relative = note(vault, valid.replace("type: glossary", "type: unknown"));
  diagnostic(vault, "frontmatter.type", relative, /unknown/);
  note(vault, valid.replace("category: engineering\n", ""));
  diagnostic(vault, "frontmatter.scope", relative, /projects\/wiki/);
  note(vault, valid);
  diagnostic(vault, "frontmatter.schema", relative, /additional.*category|category.*additional/i);
  note(vault, valid.replace("category: engineering", "title: [broken"));
  diagnostic(vault, "frontmatter.yaml", relative, /YAML/);
  custom.scopes = ["projects/wiki"];
  custom.frontmatterSchema = { type: "object", additionalProperties: true };
  save(vault, "glossary", custom);
  note(vault, valid);
  diagnostic(vault, "frontmatter.declared", relative, /category/);
  note(vault, valid.replace("category: engineering", "category: { nested: true }"));
  diagnostic(vault, "frontmatter.flat", relative, /category/);
  note(vault, valid.replace("category: engineering", "category: [1, 2]"));
  diagnostic(vault, "frontmatter.flat", relative, /category/);
});

test("okf:02 disjoint exact scopes share folders but overlapping scopes fail", () => {
  const vault = fresh();
  const first = record(vault); first.scopes = ["personal"]; save(vault, "note", first);
  const second = record(vault); second.name = "custom"; second.scopes = ["projects/wiki"];
  second.frontmatterSchema.properties.type.const = "custom"; save(vault, "custom", second);
  assert.equal(cli(vault, "type", "list").status, 0);
  second.scopes = ["personal"]; save(vault, "custom", second);
  diagnostic(vault, "registry.folder", ".wiki/types/note.json", /conflict/);
  second.scopes = []; save(vault, "custom", second);
  assert.equal(cli(vault, "type", "list").status, 0, "an empty exact scope set overlaps no scopes");
});

test("okf:02 list and validation retain required fields reached through a local schema reference", () => {
  const vault = fresh();
  const custom = record(vault); custom.name = "glossary"; custom.folder = "glossary";
  custom.frontmatterSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/fields", $defs: { fields: {
      type: "object", required: ["category"], properties: { category: { const: "engineering" } },
    } },
  };
  save(vault, "glossary", custom);
  note(vault);
  const listing = cli(vault, "type", "list");
  assert.equal(listing.status, 0);
  assert.ok(listing.data.types.find((t: { name: string }) => t.name === "glossary").requiredFields.includes("category"));
  assert.equal(cli(vault, "lint").status, 0);
});

test("okf:02 source profile keeps required locator and retrieval time with a weakened registry", () => {
  const vault = fresh();
  const source = record(vault, "source"); source.frontmatterSchema = true; save(vault, "source", source);
  const relative = note(vault, valid.replace("type: glossary", "type: source").replace("category: engineering\n", ""), "personal/references/source.md");
  diagnostic(vault, "frontmatter.schema", relative, /resource/);
  diagnostic(vault, "frontmatter.schema", relative, /retrieved/);
});

test("okf:02 existing symlink scaffold destinations are conflicts, never followed or replaced", () => {
  const vault = fresh();
  const target = path.join(temp, "missing-outside.json");
  const destination = path.join(vault, ".wiki/types/custom.json");
  fs.symlinkSync(target, destination);
  assert.equal(cli(vault, "type", "add", "custom", "--folder", "custom").status, 3);
  assert.equal(fs.readlinkSync(destination), target);
  assert.equal(fs.existsSync(target), false);
});

test("okf:02 log failure reports the published registry path and digest instead of success", () => {
  const vault = fresh();
  const log = path.join(vault, "log.md");
  fs.chmodSync(log, 0o400);
  try {
    const result = cli(vault, "type", "add", "custom", "--folder", "custom");
    assert.equal(result.status, 6, JSON.stringify(result.data));
    assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [".wiki/types/custom.json"]);
    assert.match(result.data.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(record(vault, "custom").name, "custom");
    assert.equal(fs.readFileSync(log, "utf8"), "");
  } finally { fs.chmodSync(log, 0o600); }
});

test("okf:02 human CLI exposes requirements and the honest lint boundary", () => {
  const vault = fresh();
  function human(...args: string[]) { return spawnSync(process.execPath, [BIN, "--vault", vault, ...args], { encoding: "utf8", cwd: temp }); }
  const list = human("type", "list");
  assert.equal(list.status, 0);
  assert.match(list.stdout, /decision folder=decisions required=type,title,description,created headings=2:Context and Problem Statement/);
  assert.match(list.stdout, /scopes=all/);
  const lint = human("lint");
  assert.equal(lint.status, 0);
  assert.match(lint.stdout, /body, layout, links, and indexes not checked/);
  const relative = note(vault, "---\ntype: unknown\n---\n");
  const bad = human("lint");
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.ok(bad.stderr.includes(relative + ": frontmatter.type:"));
  assert.match(bad.stderr, /fix:/);
});

test("okf:02 path-scoped lint still checks registry and refuses symlink ancestors", () => {
  const vault = fresh();
  const outside = path.join(temp, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "outside.md"), "Not vault content");
  fs.symlinkSync(outside, path.join(vault, "personal"));
  const scoped = cli(vault, "lint", "personal/outside.md");
  assert.equal(scoped.status, 1);
  assert.deepEqual(scoped.data.diagnostics.map((d: {rule: string}) => d.rule), ["path.symlink"]);
  assert.equal(cli(vault, "lint", "../outside/outside.md").data.diagnostics[0].rule, "path.invalid");
  fs.writeFileSync(path.join(vault, ".wiki/types/note.json"), "{");
  assert.ok(cli(vault, "lint", "personal/outside.md").data.diagnostics.some((d: {rule: string}) => d.rule === "registry.json"));
});

test("okf:02 scaffolding rejects unsafe input without effects and logs only successful publication", () => {
  const vault = fresh();
  const before = fs.readFileSync(path.join(vault, "log.md"), "utf8");
  for (const [name, folder] of [["../escape", "safe"], ["safe", "assets"], ["safe", "notes"]] as const) {
    assert.equal(cli(vault, "type", "add", name, "--folder", folder).status, 2);
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), before);
  }
  assert.equal(cli(vault, "type", "add", "custom", "--folder", "custom").status, 0);
  const log = fs.readFileSync(path.join(vault, "log.md"), "utf8");
  assert.match(log, /\*\*type-added\*\* \[custom\]\(\.wiki\/types\/custom.json\)/);
  assert.equal(cli(vault, "lint").status, 0);
  assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), log);
  assert.equal(fs.existsSync(path.join(vault, ".git/hooks")), false);
});
