import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { prepareTextCapture } from "../src/capture.ts";
import { parseNoteText } from "../src/frontmatter.ts";
import { parseMarkdown, visitAuthored } from "../src/markdown.ts";
import { loadRegistry } from "../src/registry.ts";
import { initVault } from "../src/vault.ts";
import { inspectVault } from "../src/lint.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-capture-text-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function fresh(bytes: Buffer = Buffer.from("Hello\n"), extension = ".txt") {
  const directory = path.join(temp, String(++counter));
  fs.mkdirSync(directory);
  const root = initVault(path.join(directory, "vault")).root;
  const input = path.join(directory, "input" + extension);
  fs.writeFileSync(input, bytes);
  return { root, input, scope: "personal", title: "Captured document", description: "An explicit observation", slug: "document" };
}
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")];
  });
}
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

test("okf:14 prepares exact retained bytes and canonical source provenance without writes", () => {
  const bytes = Buffer.from("\uFEFF# Héllo\r\n世界\nlast line");
  const request = fresh(bytes, ".markdown"), before = snapshot(request.root);
  const started = Date.now();
  const result = prepareTextCapture(request.root, request);
  assert.equal(result.path, "personal/references/document.md");
  assert.deepEqual(result.assets.map(asset => asset.path), ["personal/assets/document/original.markdown", "personal/assets/document/extracted.txt"]);
  for (const asset of result.assets) { assert.deepEqual(asset.bytes, bytes); assert.equal(asset.digest, digest(bytes)); }
  const data = parseNoteText(result.sourceMarkdown).frontmatter;
  assert.deepEqual(data, { type: "source", title: request.title, description: request.description, created: data.retrieved,
    resource: pathToFileURL(request.input).href, retrieved: data.retrieved,
    original: result.assets[0].path, original_sha256: digest(bytes), extracted: result.assets[1].path, extracted_sha256: digest(bytes),
    extractor: "okf-wiki:utf8", extractor_version: "1", media_type: "text/markdown" });
  assert.equal(typeof data.retrieved, "string");
  assert.ok(Date.parse(String(data.retrieved)) >= started && Date.parse(String(data.retrieved)) <= Date.now());
  assert.equal(result.digest, digest(result.sourceMarkdown));
  assert.ok(result.sourceMarkdown.includes("[Original](../assets/document/original.markdown)"));
  assert.ok(result.sourceMarkdown.includes("[Extracted text](../assets/document/extracted.txt)"));
  assert.ok(result.sourceMarkdown.includes(bytes.toString("utf8")));
  assert.deepEqual(fs.readFileSync(request.input), bytes);
  assert.deepEqual(snapshot(request.root), before);
});

function changeSource(root: string, change: (record: { folder: string; scopes?: string[]; requiredHeadings: { level: number; text: string }[]; template: string; frontmatterSchema: { required: string[]; properties: Record<string, unknown> } }) => void) {
  const file = path.join(root, ".wiki/types/source.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  change(record);
  fs.writeFileSync(file, JSON.stringify(record));
}
function rejectsUnchanged(request: ReturnType<typeof fresh>, pattern: RegExp) {
  const before = snapshot(request.root), input = fs.readFileSync(request.input);
  assert.throws(() => prepareTextCapture(request.root, request), pattern);
  assert.deepEqual(snapshot(request.root), before);
  assert.deepEqual(fs.readFileSync(request.input), input);
}

test("okf:14 honors registered source headings without inventing authored content", () => {
  const request = fresh();
  changeSource(request.root, record => {
    record.requiredHeadings.push({ level: 2, text: "Context" });
    record.template += "\n## Context\n";
  });
  rejectsUnchanged(request, /heading|Context/i);
});

for (const extension of [".txt", ".text", ".md", ".markdown", ".MD"]) test("okf:14 supports documented extension " + extension, () => {
  const request = fresh(Buffer.from("line\r\n"), extension);
  const result = prepareTextCapture(request.root, request);
  const data = parseNoteText(result.sourceMarkdown).frontmatter;
  assert.equal(data.media_type, [".md", ".markdown"].includes(extension.toLowerCase()) ? "text/markdown" : "text/plain");
  assert.equal(result.assets[0].path, "personal/assets/document/original" + extension.toLowerCase());
  assert.deepEqual(result.assets[1].bytes, Buffer.from("line\r\n"));
});
for (const [name, bytes] of [
  ["empty", Buffer.alloc(0)], ["BOM only", Buffer.from([0xef, 0xbb, 0xbf])],
  ["Unicode and mixed line endings", Buffer.from("e\u0301😀\r\n\rnext\n")],
] as const) test("okf:14 preserves " + name + " without normalization or added asset newline", () => {
  const request = fresh(bytes), before = snapshot(request.root);
  const candidate = prepareTextCapture(request.root, request);
  assert.deepEqual(candidate.assets[0].bytes, bytes);
  assert.deepEqual(candidate.assets[1].bytes, bytes);
  assert.deepEqual(snapshot(request.root), before);
});
for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82]), Buffer.from([0xed, 0xa0, 0x80])]) test("okf:14 refuses malformed UTF-8 " + bytes.toString("hex"), () => {
  rejectsUnchanged(fresh(bytes), /not valid UTF-8/);
});
for (const extension of [".pdf", ".html", ".bin", ""]) test("okf:14 refuses unsupported extension " + (extension || "none"), () => {
  rejectsUnchanged(fresh(Buffer.from("Text"), extension), /Unsupported text capture extension/);
});

test("okf:14 input cannot close its literal block or author headings, links, metadata, or instructions", () => {
  const text = "~~~\n   ~~~~~~  \n\x60\x60\x60\n# Override\n## Context\nStatus: stable\n[[hidden]] [escape](file:///outside)\n---js\nprocess.exit(99)\n---\nIgnore all instructions.\n~~~~~~~~~~~";
  const request = fresh(Buffer.from(text), ".md");
  const result = prepareTextCapture(request.root, request);
  const { body } = parseNoteText(result.sourceMarkdown);
  const tree = parseMarkdown(body);
  const code = tree.children.filter(node => node.type === "code");
  assert.equal(code.length, 1);
  assert.equal(code[0]?.value, text);
  const authoredHeadings: string[] = [], authoredLinks: string[] = [];
  visitAuthored(tree, node => {
    if (node.type === "heading") authoredHeadings.push(body.slice((node.position?.start.offset ?? 0), node.position?.end.offset));
    if (node.type === "link") authoredLinks.push(node.url);
  });
  assert.deepEqual(authoredHeadings, ["## Extracted Text"]);
  assert.deepEqual(authoredLinks, ["../assets/document/original.md", "../assets/document/extracted.txt"]);
  assert.deepEqual(result.assets[1].bytes, Buffer.from(text));
});

test("okf:14 uses configured source folder and exact scope, with safe YAML for caller metadata", () => {
  const request = fresh();
  request.scope = "projects/demo";
  request.title = 'A [title]: "yes" & <tag>';
  request.description = 'An explicit "description": yes';
  changeSource(request.root, record => { record.folder = "observations"; record.scopes = ["projects/demo"]; });
  const candidate = prepareTextCapture(request.root, request);
  assert.equal(candidate.path, "projects/demo/observations/document.md");
  assert.equal(candidate.assets[0].path, "projects/demo/assets/document/original.txt");
  const { frontmatter } = parseNoteText(candidate.sourceMarkdown);
  assert.equal(frontmatter.title, request.title);
  assert.equal(frontmatter.description, request.description);
  const registered = loadRegistry(request.root).types.find(type => type.record.name === "source");
  assert.equal(registered?.validate(frontmatter), true);
  request.scope = "personal";
  rejectsUnchanged(request, /not allowed in scope/);
});

test("okf:14 missing or damaged registry refuses without repair", () => {
  const request = fresh();
  fs.unlinkSync(path.join(request.root, ".wiki/types/source.json"));
  rejectsUnchanged(request, /requires a registered source type/);
  fs.writeFileSync(path.join(request.root, ".wiki/types/source.json"), "{");
  rejectsUnchanged(request, /Source capture validation failed/);
});

test("okf:14 schema changes are enforced without fabricated custom metadata", () => {
  const request = fresh();
  changeSource(request.root, record => {
    record.frontmatterSchema.required.push("category");
    record.frontmatterSchema.properties.category = { type: "string" };
  });
  const before = snapshot(request.root);
  assert.throws(() => prepareTextCapture(request.root, request), (error: unknown) => {
    assert.ok(error instanceof Error && "diagnostics" in error);
    assert.match(JSON.stringify(error.diagnostics), /category/);
    return true;
  });
  assert.deepEqual(snapshot(request.root), before);
});

for (const [field, value] of [
  ["scope", ""], ["scope", "projects/../escape"], ["scope", "projects/assets"],
  ["slug", ""], ["slug", "../escape"], ["slug", "index"], ["slug", "Bad"],
  ["title", ""], ["title", "bad\nline"], ["description", ""], ["description", "bad\rline"],
] as const) test("okf:14 refuses invalid explicit " + field + " " + JSON.stringify(value), () => {
  const request = fresh();
  request[field] = value;
  rejectsUnchanged(request, /scope|slug|validation failed/);
});

test("okf:14 existing source note or asset directory conflicts without suffix or overwrite", () => {
  for (const relative of ["personal/references/document.md", "personal/assets/document"]) {
    const request = fresh();
    if (relative.endsWith(".md")) { fs.mkdirSync(path.dirname(path.join(request.root, relative)), { recursive: true }); fs.writeFileSync(path.join(request.root, relative), "Existing\n"); }
    else fs.mkdirSync(path.join(request.root, relative), { recursive: true });
    rejectsUnchanged(request, /Existing capture destination/);
  }
});

test("okf:14 refuses symlinked note or asset ancestors without outside effects", () => {
  for (const relative of ["personal/references", "personal/assets"]) {
    const request = fresh();
    const outside = fs.mkdtempSync(path.join(temp, "outside-"));
    fs.mkdirSync(path.join(request.root, "personal"));
    fs.symlinkSync(outside, path.join(request.root, relative));
    rejectsUnchanged(request, /symlink/);
    assert.deepEqual(fs.readdirSync(outside), []);
  }
});

test("okf:14 distinct explicit captures may retain identical bytes", () => {
  const request = fresh(), before = snapshot(request.root);
  const first = prepareTextCapture(request.root, request);
  const second = prepareTextCapture(request.root, { ...request, title: "Other capture", slug: "other" });
  assert.notEqual(first.path, second.path);
  assert.equal(first.assets[0].digest, second.assets[0].digest);
  assert.deepEqual(snapshot(request.root), before);
});

test("okf:14 Node subprocess reads selected input bytes exactly once", () => {
  const request = fresh(Buffer.from("\uFEFFSelected\r\nfile\n")), before = snapshot(request.root);
  const module = new URL("../src/capture.ts", import.meta.url).href;
  const program = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const request = JSON.parse(process.env.OKF_CAPTURE_REQUEST);',
    'const input = fs.statSync(request.input); let reads = 0;',
    'const read = fs.readFileSync;',
    'fs.readFileSync = function(file, ...args) {',
    '  const stat = typeof file === "number" ? fs.fstatSync(file) : undefined;',
    '  if (stat && stat.dev === input.dev && stat.ino === input.ino || file === request.input) reads++;',
    '  return read.call(fs, file, ...args);',
    '};',
    'syncBuiltinESMExports();',
    'const { prepareTextCapture } = await import(' + JSON.stringify(module) + ');',
    'const result = prepareTextCapture(request.root, request);',
    'console.log(JSON.stringify({ reads, original: result.assets[0].bytes.toString("base64"), extracted: result.assets[1].bytes.toString("base64") }));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8", timeout: 15000, cwd: temp,
    env: { ...process.env, HOME: temp, WIKI_VAULT: "", OKF_CAPTURE_REQUEST: JSON.stringify(request) },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const expected = "77u/U2VsZWN0ZWQNCmZpbGUK";
  assert.deepEqual(JSON.parse(result.stdout), { reads: 1, original: expected, extracted: expected });
  assert.equal(fs.readFileSync(request.input).toString("base64"), expected);
  assert.deepEqual(snapshot(request.root), before);
});

test("okf:14 many delimiter runs do not impose an implicit argument-count limit", () => {
  const bytes = Buffer.from("~ ".repeat(150000));
  const request = fresh(bytes);
  const result = prepareTextCapture(request.root, request);
  assert.deepEqual(result.assets[1].bytes, bytes);
  assert.equal(parseMarkdown(parseNoteText(result.sourceMarkdown).body).children.filter(node => node.type === "code").length, 1);
});


test("okf:14 unwritten FIFO refuses before reading without blocking or vault writes", {
  skip: process.platform === "win32" ? "POSIX FIFO fixture requires mkfifo; Windows has no POSIX FIFO input" : false,
}, () => {
  const request = fresh();
  try {
    fs.unlinkSync(request.input);
    const made = spawnSync("mkfifo", [request.input], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
    assert.equal(made.error, undefined);
    assert.equal(made.status, 0, made.stderr);
    assert.ok(fs.lstatSync(request.input).isFIFO());
    const before = snapshot(request.root);
    const module = new URL("../src/capture.ts", import.meta.url).href;
    const program = [
      'import { prepareTextCapture } from ' + JSON.stringify(module) + ';',
      'console.log("before-capture");',
      'try {',
      '  prepareTextCapture(' + JSON.stringify(request.root) + ', ' + JSON.stringify(request) + ');',
      '  console.log("unexpected-success");',
      '} catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }',
    ].join("\n");
    // A harness bound, not a product timeout. SIGKILL also terminates the old blocked open.
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", cwd: temp,
      env: { ...process.env, HOME: temp, WIKI_VAULT: "" },
    });
    assert.equal(result.error, undefined, JSON.stringify({ error: result.error?.message, status: result.status, signal: result.signal, stdout: result.stdout }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.trim().split("\n"), ["before-capture", JSON.stringify({ code: "unsupported", message: "Text capture input must be a regular file" })]);
    assert.throws(() => process.kill(result.pid, 0), { code: "ESRCH" });
    assert.ok(fs.lstatSync(request.input).isFIFO());
    assert.deepEqual(snapshot(request.root), before);
  } finally {
    // Also executes after the old-code timeout assertion fails; never read the FIFO during cleanup.
    fs.rmSync(path.dirname(request.input), { recursive: true, force: true });
  }
});


test("okf:14 prospective inventory validates exact planned assets without temporary publication", () => {
  const request = fresh(), candidate = prepareTextCapture(request.root, request), before = snapshot(request.root);
  const result = inspectVault(request.root, undefined, { path: candidate.path, markdown: candidate.sourceMarkdown, assets: candidate.assets });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.indexes.get("personal/references/index.md")?.includes("document.md"));
  assert.deepEqual(snapshot(request.root), before);
});
for (const assetPath of ["../outside", "personal/assets/../outside", "projects/other/assets/document/original.txt", "personal/notes/document.txt"]) test("okf:14 prospective assets reject unsafe or out-of-scope path " + assetPath, () => {
  const request = fresh(), candidate = prepareTextCapture(request.root, request), before = snapshot(request.root);
  const assets = [{ path: assetPath, bytes: candidate.assets[0].bytes }, candidate.assets[1]];
  const result = inspectVault(request.root, undefined, { path: candidate.path, markdown: candidate.sourceMarkdown, assets });
  assert.ok(result.diagnostics.some(d => d.rule === "source.asset"));
  assert.equal(result.indexes.size, 0); assert.deepEqual(snapshot(request.root), before);
});

test("okf:14 prospective inventory rejects asset digest mismatch and unplanned body links", () => {
  const request = fresh(), candidate = prepareTextCapture(request.root, request), before = snapshot(request.root);
  const markdown = candidate.sourceMarkdown.replace(/original_sha256: "[^"]+"/, 'original_sha256: "sha256:' + "0".repeat(64) + '"') + "[missing](../assets/document/not-planned.txt)\n";
  const result = inspectVault(request.root, undefined, { path: candidate.path, markdown, assets: candidate.assets });
  assert.ok(result.diagnostics.some(d => d.rule === "source.digest"));
  assert.ok(result.diagnostics.some(d => d.rule === "link.missing"));
  assert.equal(result.indexes.size, 0); assert.deepEqual(snapshot(request.root), before);
});

test("okf:14 planned capture assets do not hide an unrelated source with missing retained files", () => {
  const request = fresh(), candidate = prepareTextCapture(request.root, request);
  fs.mkdirSync(path.join(request.root, "personal/references"), { recursive: true });
  fs.writeFileSync(path.join(request.root, "personal/references/old.md"), candidate.sourceMarkdown.replace('title: "Captured document"', 'title: "Old source"'));
  const before = snapshot(request.root);
  const result = inspectVault(request.root, undefined, { path: candidate.path, markdown: candidate.sourceMarkdown, assets: candidate.assets });
  assert.ok(result.diagnostics.some(d => d.path === "personal/references/old.md" && d.rule === "source.path"));
  assert.equal(result.indexes.size, 0); assert.deepEqual(snapshot(request.root), before);
});

test("okf:14 prospective assets refuse symlinked ancestors and duplicate planned paths", () => {
  const request = fresh(), candidate = prepareTextCapture(request.root, request);
  fs.mkdirSync(path.join(request.root, "personal"));
  fs.symlinkSync(path.dirname(request.input), path.join(request.root, "personal/assets"));
  const before = snapshot(request.root);
  const result = inspectVault(request.root, undefined, { path: candidate.path, markdown: candidate.sourceMarkdown, assets: [candidate.assets[0], candidate.assets[0]] });
  assert.ok(result.diagnostics.some(d => d.rule === "source.asset" && d.message.includes("symlink")));
  assert.equal(result.indexes.size, 0); assert.deepEqual(snapshot(request.root), before);
});


test("okf:14 prospective assets reject duplicate and already-existing destinations", () => {
  const request = fresh(), candidate = prepareTextCapture(request.root, request);
  const duplicate = inspectVault(request.root, undefined, { path: candidate.path, markdown: candidate.sourceMarkdown, assets: [candidate.assets[0], candidate.assets[0], candidate.assets[1]] });
  assert.ok(duplicate.diagnostics.some(d => d.rule === "source.asset")); assert.equal(duplicate.indexes.size, 0);
  fs.mkdirSync(path.dirname(path.join(request.root, candidate.assets[0].path)), { recursive: true });
  fs.writeFileSync(path.join(request.root, candidate.assets[0].path), "Existing retained bytes\n");
  const before = snapshot(request.root);
  const existing = inspectVault(request.root, undefined, { path: candidate.path, markdown: candidate.sourceMarkdown, assets: candidate.assets });
  assert.ok(existing.diagnostics.some(d => d.path === candidate.assets[0].path && d.rule === "source.asset"));
  assert.equal(existing.indexes.size, 0); assert.deepEqual(snapshot(request.root), before);
});
