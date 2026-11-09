// Principal acceptance seam: a real Node subprocess with disposable filesystem state.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-init-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function freshPath(): string { return path.join(temp, "vault-" + ++counter); }
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [BIN, "--json", ...args], {
    encoding: "utf8", cwd: temp, env: { ...process.env, WIKI_VAULT: "", HOME: temp, ...env },
  });
}
function ok(args: string[], env?: NodeJS.ProcessEnv) {
  const result = cli(args, env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, true);
  return data;
}
function rejected(args: string[], status: number, code: string, message: RegExp, env?: NodeJS.ProcessEnv) {
  const result = cli(args, env);
  assert.equal(result.status, status, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  assert.equal(data.error.code, code);
  assert.match(data.error.message, message);
  return data;
}
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isFile()) files[path.relative(root, full)] = fs.readFileSync(full).toString("base64");
  }
  return files;
}

test("okf:01 repeat init preserves authored notes, registry, config, indexes, and ignores", () => {
  const vault = freshPath();
  ok(["init", vault]);
  fs.mkdirSync(path.join(vault, "personal/notes"), { recursive: true });
  fs.writeFileSync(path.join(vault, "personal/notes/idea.md"), "Authored bytes\r\n");
  fs.writeFileSync(path.join(vault, "index.md"), "Authored navigation\n");
  fs.appendFileSync(path.join(vault, ".gitignore"), "private/\n");
  fs.writeFileSync(path.join(vault, ".wiki/config.json"), '{ "profile": "wiki-okf", "version": 1 }\n');
  fs.writeFileSync(path.join(vault, ".wiki/types/note.json"), '{"reviewed":"custom data"}\n');
  const before = snapshot(vault);
  ok(["--vault", vault, "init"]);
  assert.deepEqual(snapshot(vault), before);
});

test("okf:01 refuses a nonempty foreign target without any mutation", () => {
  const vault = freshPath();
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, "authored.md"), "Do not convert me.\n");
  const before = snapshot(vault);
  rejected(["init", vault], 5, "unsupported", /nonempty foreign/i);
  assert.deepEqual(snapshot(vault), before);
  assert.deepEqual(fs.readdirSync(vault), ["authored.md"]);
});

test("okf:01 refuses unsupported and damaged configurations without mutation", () => {
  for (const config of ['{"profile":"wiki-okf","version":99}', '{"profile":"foreign","version":1}', '{', '[]', '{}']) {
    const vault = freshPath();
    ok(["init", vault]);
    fs.writeFileSync(path.join(vault, ".wiki/config.json"), config);
    const before = snapshot(vault);
    const unsupported = config.includes('99') || config.includes('foreign');
    rejected(["init", vault], unsupported ? 5 : 6, unsupported ? "unsupported" : "damaged", /config|profile/i);
    assert.deepEqual(snapshot(vault), before);
  }
});

test("okf:01 reports missing initialization files instead of attempting repair", () => {
  for (const missing of [".wiki/config.json", "index.md", "log.md", ".gitignore", ".wiki/types", ".wiki/tmp", ".wiki/locks"]) {
    const vault = freshPath();
    ok(["init", vault]);
    fs.rmSync(path.join(vault, missing), { recursive: true });
    const before = snapshot(vault);
    const result = rejected(["init", vault], 6, "damaged", /incomplete/i);
    assert.ok(result.error.message.includes(missing), result.error.message);
    assert.deepEqual(snapshot(vault), before);
    assert.equal(fs.existsSync(path.join(vault, missing)), false);
  }
});

test("okf:01 refuses symlink roots, managed files, and write directories", () => {
  const outside = freshPath();
  ok(["init", outside]);
  const link = freshPath();
  fs.symlinkSync(outside, link);
  const outsideBefore = snapshot(outside);
  rejected(["init", link], 2, "usage", /symlink/i);
  assert.deepEqual(snapshot(outside), outsideBefore);
  for (const relative of [".wiki", ".wiki/config.json", ".wiki/types", ".wiki/tmp", ".wiki/locks", "index.md", "log.md", ".gitignore"]) {
    const vault = freshPath();
    ok(["init", vault]);
    fs.rmSync(path.join(vault, relative), { recursive: true });
    fs.symlinkSync(path.join(outside, relative), path.join(vault, relative));
    const before = snapshot(vault);
    rejected(["init", vault], 2, "usage", /symlink/i);
    assert.deepEqual(snapshot(vault), before);
    assert.deepEqual(snapshot(outside), outsideBefore);
  }
});

test("okf:01 requires explicit selection and honors flag precedence over environment", () => {
  const before = snapshot(temp);
  rejected(["init"], 2, "usage", /no default vault/i);
  rejected(["init", ""], 2, "usage", /select a vault/i);
  assert.deepEqual(snapshot(temp), before);
  const selected = freshPath();
  const ignored = freshPath();
  ok(["--vault", selected, "init"], { WIKI_VAULT: ignored });
  assert.equal(fs.existsSync(ignored), false);
  const fromEnv = freshPath();
  ok(["init"], { WIKI_VAULT: fromEnv });
  const positional = freshPath();
  ok(["init", positional], { WIKI_VAULT: ignored });
  assert.equal(fs.existsSync(ignored), false);
  const other = freshPath();
  rejected(["--vault", selected, "init", other], 2, "usage", /different|conflict/i);
  assert.equal(fs.existsSync(other), false);
  rejected(["--vault", "", "init"], 2, "usage", /select a vault/i, { WIKI_VAULT: ignored });
  assert.equal(fs.existsSync(ignored), false);
});

test("okf:01 accepts an explicitly selected empty relative directory with literal path characters", () => {
  const relative = "empty vault ; literal";
  fs.mkdirSync(path.join(temp, relative));
  const result = ok(["init", relative]);
  assert.equal(result.vault.root, fs.realpathSync(path.join(temp, relative)));
  const human = spawnSync(process.execPath, [BIN, "init", relative], {
    encoding: "utf8", cwd: temp, env: { ...process.env, WIKI_VAULT: "" },
  });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, "Initialized profile vault: " + result.vault.root + "\n");
});

test("okf:01 CLI errors are JSON, while human errors go to stderr", () => {
  rejected(["--unknown"], 2, "usage", /unknown/i);
  rejected(["new"], 2, "usage", /usage/i);
  rejected(["init", freshPath(), "extra"], 2, "usage", /usage/i);
  const human = spawnSync(process.execPath, [BIN, "init"], { encoding: "utf8", env: { ...process.env, WIKI_VAULT: "" } });
  assert.equal(human.status, 2);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /no default vault/i);
});

test("okf:01 Node init seeds an isolated profile without Git or search state", () => {
  const vault = freshPath();
  const result = ok(["init", vault]);
  assert.equal(result.vault.root, fs.realpathSync(vault));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, ".wiki/config.json"), "utf8")), {
    profile: "wiki-okf", version: 1,
  });
  const types = fs.readdirSync(path.join(vault, ".wiki/types")).sort();
  assert.deepEqual(types, ["architecture.json", "decision.json", "note.json", "procedure.json", "reference.json", "research.json", "source.json"]);
  const expectedSeeds = [
    ["architecture", "architecture", []],
    ["decision", "decisions", ["2:Context and Problem Statement", "2:Considered Options", "2:Decision Outcome", "3:Consequences"]],
    ["note", "notes", []], ["procedure", "procedures", ["2:Steps"]],
    ["reference", "reference", []], ["research", "research", ["2:Findings", "2:Sources"]],
    ["source", "references", ["2:Extracted Text"]],
  ] as const;
  for (const [name, folder, headings] of expectedSeeds) {
    const seed = JSON.parse(fs.readFileSync(path.join(vault, ".wiki/types", name + ".json"), "utf8"));
    assert.equal(seed.name, name);
    assert.equal(seed.folder, folder);
    assert.equal(seed.frontmatterSchema.properties.type.const, name);
    assert.deepEqual(seed.requiredHeadings.map((h: { level: number; text: string }) => h.level + ":" + h.text), headings);
    for (const h of seed.requiredHeadings) assert.ok(seed.template.includes("#".repeat(h.level) + " " + h.text + "\n"));
    assert.equal(seed.scopes, undefined, "seeds allow both project and personal scopes");
  }
  const source = JSON.parse(fs.readFileSync(path.join(vault, ".wiki/types/source.json"), "utf8"));
  for (const key of ["resource", "retrieved", "original", "original_sha256", "extracted", "extracted_sha256", "extractor", "extractor_version", "media_type"]) {
    assert.ok(source.frontmatterSchema.required.includes(key), key);
  }
  const decision = JSON.parse(fs.readFileSync(path.join(vault, ".wiki/types/decision.json"), "utf8"));
  assert.equal(decision.name, "decision");
  assert.equal(decision.folder, "decisions");
  assert.equal(decision.frontmatterSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(decision.frontmatterSchema.required, ["type", "title", "description", "created"]);
  assert.match(decision.template, /^## Context and Problem Statement\n/m);
  assert.match(decision.template, /^### Consequences\n/m);
  assert.equal(fs.readFileSync(path.join(vault, "index.md"), "utf8"), '---\nokf_version: "0.2"\n---\n# Wiki\n');
  assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), "");
  const ignores = fs.readFileSync(path.join(vault, ".gitignore"), "utf8");
  for (const rule of ["/.wiki/tmp/", "/.wiki/locks/", "/.wiki/search/", "/.wiki/qmd.sqlite", "/.wiki/qmd.sqlite-*"]) assert.ok(ignores.split("\n").includes(rule));
  assert.equal(fs.existsSync(path.join(vault, ".git")), false);
  assert.equal(fs.existsSync(path.join(vault, ".wiki/qmd.sqlite")), false);
  assert.equal(fs.existsSync(path.join(temp, ".cache")), false);
});
