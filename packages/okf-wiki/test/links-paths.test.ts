import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-links-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function cli(vault: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./link-network-guard.js", import.meta.url)), BIN, "--json", "--vault", vault, ...args], {
    encoding: "utf8", cwd: temp, env: { ...process.env, HOME: temp, WIKI_VAULT: "", OKF_TEST_ROOT: temp, OKF_TEST_VAULT: vault },
  });
  assert.equal(result.stderr, "");
  return { status: result.status, data: JSON.parse(result.stdout) };
}
function fresh() {
  const vault = path.join(temp, String(++counter));
  assert.equal(cli(vault, "init").status, 0);
  return vault;
}
function write(vault: string, relative: string, bytes: string) {
  fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
  fs.writeFileSync(path.join(vault, relative), bytes);
}
const TOPIC = "personal/notes/topic.md";
function note(vault: string, body: string, relative = TOPIC, fields = "", type = "note") {
  write(vault, relative, '---\ntype: ' + type + '\ntitle: ' + JSON.stringify(relative) + '\ndescription: A topic\ncreated: "2026-11-06T12:00:00Z"\n' + fields + '---\n' + body);
}
function rejects(vault: string, rule: string, selected?: string) {
  const result = cli(vault, "lint", ...(selected === undefined ? [] : [selected]));
  assert.equal(result.status, 1, JSON.stringify(result));
  assert.ok(result.data.diagnostics.some((d: { rule: string; fix: string }) => d.rule === rule && d.fix.length > 0), JSON.stringify(result));
  return result;
}

test("okf:04 broken direct, reference and image targets fail in whole and selected lint", () => {
  const vault = fresh();
  for (const body of ["[missing](missing.md)", "[missing][target]\n\n[target]: missing.md", "![missing](missing.png)"]) {
    note(vault, body);
    for (const selected of [undefined, TOPIC, "personal/notes"]) rejects(vault, "link.missing", selected);
  }
});

test("okf:04 direct, reference, collapsed, shortcut, image, parent, fragment, index and asset links validate without network", () => {
  const vault = fresh();
  note(vault, "Replacement", "personal/architecture/other.md", "", "architecture");
  write(vault, "personal/index.md", "# Personal\n");
  write(vault, "personal/assets/capture/image with space.png", "retained bytes");
  write(vault, "personal/assets/capture/100%.txt", "Literal percent file name");
  write(vault, "personal/assets/capture/original.md", "[[literal source]]\n[not authored](missing)\n");
  const body = [
    "[direct](../architecture/other.md)", "[reference][r]", "[collapsed][]", "[shortcut]",
    "![image](../assets/capture/image%20with%20space.png)", "![reference image][image]",
    "[parent index](../index.md)", "[root index](../../index.md)", "[self](#arbitrary%20heading)", "[literal fragment](#uninterpreted%ZZ)",
    "[fragment](../architecture/other.md#not-a-real-heading)", "[original](../assets/capture/original.md)", "[percent file](../assets/capture/100%25.txt)",
    "[https](https://example.invalid/not-fetched)", "<http://example.invalid/>", "[mail](mailto:someone@example.invalid)",
    "", "[r]: ../architecture/other.md", "[collapsed]: ../architecture/other.md", "[shortcut]: ../architecture/other.md",
    "[image]: ../assets/capture/image%20with%20space.png",
  ].join("\n\n");
  note(vault, body);
  const before = fs.readFileSync(path.join(vault, TOPIC), "utf8");
  for (const selected of [[], [TOPIC], ["personal"]]) assert.equal(cli(vault, "lint", ...selected).status, 0);
  assert.equal(fs.readFileSync(path.join(vault, TOPIC), "utf8"), before, "fragments and authored bytes are unchanged");
});

test("okf:04 unsafe schemes, root links, malformed encoding and non-content targets have actionable diagnostics", () => {
  const vault = fresh();
  for (const [url, rule] of [
    ["/personal/notes/topic.md", "link.unsafe"], ["//example.invalid/note.md", "link.unsafe"],
    ["file:///tmp/sentinel", "link.scheme"], ["javascript:alert(1)", "link.scheme"], ["data:text/plain,example", "link.scheme"],
    ["%6aavascript:alert(1)", "link.scheme"], ["bad%ZZ.md", "link.invalid"], ["https://", "link.invalid"],
    ["%2foutside.md", "link.unsafe"], ["..%5coutside.md", "link.unsafe"], ["bad%00.md", "link.unsafe"],
    ["../../.wiki/config.json", "link.target"], ["../../log.md", "link.target"], ["../notes", "link.target"],
  ] satisfies [string, string][]) {
    note(vault, "[target](" + url + ")");
    const result = rejects(vault, rule, TOPIC);
    assert.deepEqual(result.data.diagnostics.map((d: { rule: string }) => d.rule), [rule], url);
  }
});

test("okf:04 escaped, fenced, inline, quoted and literal captures are not authored links or wikilinks", () => {
  const vault = fresh();
  note(vault, [
    "\\[[escaped]] and \\[example](missing.md) and &#91;&#91;entity example&#93;&#93;",
    "\x60[[inline]] [bad](missing.md)\x60",
    "~~~md\n[[fenced]]\n[bad](missing.md)\n~~~",
    "    [[indented]]\n    [bad](missing.md)",
    "> [[quoted]]\n> [bad](missing.md)",
    "<pre>\n[[literal]]\n[bad](missing.md)\n</pre>",
  ].join("\n\n"));
  assert.equal(cli(vault, "lint").status, 0);
  for (const body of ["[[authored]]", "![[image]]", "[[note|label]]", "\\\\[[not-escaped]]"]) {
    note(vault, body);
    rejects(vault, "link.wikilink", TOPIC);
  }
});

test("okf:04 traversal and decoded escapes never inspect an outside sentinel", () => {
  const vault = fresh();
  const sentinel = path.join(temp, "sentinel.md");
  const bytes = "---\ninvalid: [\n---\noutside content must not be parsed\n";
  fs.writeFileSync(sentinel, bytes);
  for (const url of ["../../../sentinel.md", "%2e%2e/%2e%2e/%2e%2e/sentinel.md", "..%2f..%2f..%2fsentinel.md", "%252e%252e/%252e%252e/sentinel.md"]) {
    note(vault, "[outside](" + url + ")");
    const result = rejects(vault, "link.unsafe", TOPIC);
    assert.deepEqual(result.data.diagnostics.map((d: { rule: string }) => d.rule), ["link.unsafe"]);
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), bytes);
});

test("okf:04 canonical CLI paths reject traversal, empty segments, absolute and encoded unsafe components", () => {
  const vault = fresh();
  note(vault, "Valid body");
  for (const selected of ["", ".", "..", "../sentinel.md", "/personal/notes/topic.md", "personal//notes/topic.md", "personal/./notes/topic.md", "personal/notes/../notes/topic.md", "personal\\notes\\topic.md", "personal/%2e%2e/topic.md", "C:/outside.md"]) {
    const result = rejects(vault, "path.invalid", selected);
    assert.deepEqual(result.data.diagnostics.map((d: { rule: string }) => d.rule), ["path.invalid"], selected);
  }
});

test("okf:04 symlinked notes, link targets and ancestors are refused before reading outside content", () => {
  const vault = fresh();
  const outside = path.join(temp, "outside-" + counter);
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, "target.md");
  fs.writeFileSync(sentinel, "---\ninvalid: [\n---\n");
  note(vault, "[file](../assets/capture/file.md)");
  fs.mkdirSync(path.join(vault, "personal/assets/capture"), { recursive: true });
  fs.symlinkSync(sentinel, path.join(vault, "personal/assets/capture/file.md"));
  rejects(vault, "link.symlink", TOPIC);
  fs.symlinkSync(outside, path.join(vault, "personal/assets/alias"));
  note(vault, "[ancestor](../assets/alias/target.md)");
  rejects(vault, "link.symlink", TOPIC);
  fs.symlinkSync(outside, path.join(vault, "personal/architecture"));
  rejects(vault, "path.symlink", "personal/architecture/target.md");
  const result = rejects(vault, "path.symlink");
  assert.ok(!result.data.diagnostics.some((d: { rule: string }) => d.rule === "frontmatter.yaml"));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "---\ninvalid: [\n---\n");
});

test("okf:04 canonical lifecycle metadata differs from contained parent links and custom strings are not guessed as paths", () => {
  const vault = fresh();
  const target = "personal/architecture/replacement.md";
  note(vault, "Replacement", target, "", "architecture");
  const registry = path.join(vault, ".wiki/types/note.json");
  const record = JSON.parse(fs.readFileSync(registry, "utf8"));
  record.frontmatterSchema.properties.custom_locator = { type: "string" };
  fs.writeFileSync(registry, JSON.stringify(record));
  for (const value of ["../architecture/replacement.md", "/" + target, "personal/architecture/../architecture/replacement.md", "personal/%61rchitecture/replacement.md"]) {
    note(vault, "[relative](../architecture/replacement.md)", TOPIC, "status: deprecated\nsuperseded_by: " + JSON.stringify(value) + "\n");
    const result = rejects(vault, "lifecycle.target", TOPIC);
    assert.deepEqual(result.data.diagnostics.map((d: { rule: string }) => d.rule), ["lifecycle.target"]);
  }
  note(vault, "[relative](../architecture/replacement.md)", TOPIC, "status: deprecated\nsuperseded_by: " + target + '\ncustom_locator: "../not-a-supported-path-field"\n');
  assert.equal(cli(vault, "lint").status, 0);
});

test("okf:04 retained source metadata requires canonical asset paths, unlike body destinations and resource locators", () => {
  const vault = fresh();
  const relative = "personal/references/source.md";
  const original = "personal/assets/capture/original.txt", extracted = "personal/assets/capture/extracted.txt";
  write(vault, original, "Original source bytes");
  write(vault, extracted, "Extracted source bytes");
  function source(value: string) {
    write(vault, relative, '---\ntype: source\ntitle: Source\ndescription: A source\ncreated: "2026-11-06T12:00:00Z"\nresource: "../original-locator"\nretrieved: "2026-11-06T12:00:00Z"\noriginal: ' + JSON.stringify(value) + '\nextracted: ' + extracted + '\noriginal_sha256: sha256:' + "a".repeat(64) + '\nextracted_sha256: sha256:' + "b".repeat(64) + '\nextractor: fixture\nextractor_version: "1"\nmedia_type: text/plain\n---\n## Extracted Text\n\n[original](../assets/capture/original.txt)\n\n~~~text\n[[raw captured source]] [unsafe](file:///example)\n~~~\n');
  }
  for (const value of ["../assets/capture/original.txt", "/" + original, "personal/assets/../assets/capture/original.txt", "personal/assets/capture/missing.txt", "personal/assets/%2e%2e/original.txt", "personal/assets/capture/bad\0.txt"]) {
    source(value);
    const result = rejects(vault, "source.path", relative);
    assert.deepEqual(result.data.diagnostics.map((d: { rule: string }) => d.rule), ["source.path"]);
  }
  source(original);
  assert.equal(cli(vault, "lint").status, 0);
  const outside = path.join(temp, "source-sentinel-" + counter);
  fs.writeFileSync(outside, "outside retained bytes");
  fs.unlinkSync(path.join(vault, original));
  fs.symlinkSync(outside, path.join(vault, original));
  rejects(vault, "source.path", relative);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside retained bytes");
});

test("okf:04 authored references still validate definitions declared in quoted source", () => {
  const vault = fresh();
  note(vault, "[authored][target]\n\n> [target]: file:///outside\n");
  rejects(vault, "link.scheme", TOPIC);
});

test("okf:04 formatted wikilink labels remain forbidden but inline-code examples do not join into syntax", () => {
  const vault = fresh();
  for (const body of ["[[note|*label*]]", "[[note|**label**]]"]) {
    note(vault, body);
    rejects(vault, "link.wikilink", TOPIC);
  }
  note(vault, "[[\x60example\x60]]\n\n[\x60[example]\x60]\n");
  assert.equal(cli(vault, "lint").status, 0);
});

test("okf:04 current registry writes refuse symlinked managed ancestors and preserve outside sentinels", () => {
  for (const relative of [".wiki/types", ".wiki/tmp"]) {
    const vault = fresh();
    const outside = path.join(temp, "write-sentinel-" + counter);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "Do not read or change");
    fs.renameSync(path.join(vault, relative), path.join(vault, relative + "-retained"));
    fs.symlinkSync(outside, path.join(vault, relative));
    const before = fs.readFileSync(path.join(vault, "log.md"), "utf8");
    const result = cli(vault, "type", "add", "glossary", "--folder", "glossary");
    assert.equal(result.status, 2, JSON.stringify(result));
    assert.equal(result.data.error.code, "usage");
    assert.match(result.data.error.message, /symlink/i);
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
    assert.equal(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "Do not read or change");
    assert.equal(fs.readFileSync(path.join(vault, "log.md"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(vault, ".wiki/types-retained/glossary.json")), false);
  }
});
