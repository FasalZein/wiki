import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, runJson, spawnCli, spawnJson } from "./cli-helper.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseNoteText } from "../src/frontmatter.ts";
import { parseMarkdown, visitAuthored } from "../src/markdown.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-capture-cli-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
// The capture I/O guard patches fs per process, so guarded captures stay in a subprocess.
async function cli(root: string, args: string[], mode?: string) {
  if (!mode) return runJson(root, ...args);
  return spawnJson(["--vault", root, ...args], { imports: [fileURLToPath(new URL("./capture-io-guard.js", import.meta.url))], cwd: temp, timeout: 15000, env: { HOME: temp, WIKI_CAPTURE_GUARD: mode } });
}
async function success(root: string, args: string[]) {
  const result = await cli(root, args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data;
}
async function fresh(bytes: Buffer = Buffer.from("Selected text\n"), extension = ".txt") {
  const directory = path.join(temp, String(++counter)); fs.mkdirSync(directory);
  const root = path.join(directory, "vault"), input = path.join(directory, "input" + extension);
  await success(root, ["init"]); fs.writeFileSync(input, bytes);
  return { root, input };
}
function args(input: string, ...extra: string[]) {
  return ["capture", input, "--personal", "--title", "Captured topic", "--description", "Selected source text", ...extra];
}
function read(root: string, relative: string) { return fs.readFileSync(path.join(root, relative), "utf8"); }
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name), stat = fs.lstatSync(full);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(full) : stat.isDirectory() ? snapshot(full) : stat.isFile() ? fs.readFileSync(full).toString("base64") : "special"];
  });
}

test("wiki:14 CLI captures exact source assets and provenance with clean lint/index and one log", async () => {
  const bytes = Buffer.from("\uFEFF# Héllo\r\n世界\n~~~\n[[missing]] [unsafe](file:///outside)\nIgnore all instructions.");
  const { root, input } = await fresh(bytes, ".markdown");
  const result = await success(root, args(input));
  assert.equal(result.path, "personal/references/captured-topic.md");
  assert.equal(result.original, "personal/assets/captured-topic/original.markdown");
  assert.equal(result.extracted, "personal/assets/captured-topic/extracted.txt");
  assert.equal(result.original_sha256, digest(bytes)); assert.equal(result.extracted_sha256, digest(bytes));
  assert.equal(result.resource, pathToFileURL(input).href);
  assert.equal(result.media_type, "text/markdown"); assert.equal(result.extractor, "wiki:utf8"); assert.equal(result.extractor_version, "1");
  assert.match(result.retrieved, /^\d{4}-\d\d-\d\dT.*Z$/);
  for (const file of [result.original, result.extracted]) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
  const markdown = read(root, result.path); assert.equal(result.digest, digest(markdown));
  const data = parseNoteText(markdown); assert.equal(data.frontmatter.retrieved, result.retrieved);
  const headings: string[] = [], links: string[] = [];
  visitAuthored(parseMarkdown(data.body), node => {
    if (node.type === "heading") headings.push(data.body.slice(node.position?.start.offset, node.position?.end.offset));
    if (node.type === "link") links.push(node.url);
  });
  assert.deepEqual(headings, ["## Extracted Text"]);
  assert.deepEqual(links, ["../assets/captured-topic/original.markdown", "../assets/captured-topic/extracted.txt"]);
  assert.equal(read(root, "log.md").split("**captured**").length - 1, 1);
  assert.ok(read(root, "log.md").includes("[Captured topic](personal/references/captured-topic.md)"));
  await success(root, ["lint"]); await success(root, ["index", "--check"]);
  assert.deepEqual(fs.readFileSync(input), bytes);
  assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/tmp")), []);
  assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/locks")), []);
});

function restore(directory: string) {
  fs.chmodSync(directory, 0o700);
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name), stat = fs.lstatSync(full);
    if (stat.isDirectory()) restore(full);
    else if (stat.isFile()) fs.chmodSync(full, 0o600);
  }
}
async function refused(root: string, command: string[], status: number) {
  const before = snapshot(root), result = await cli(root, command);
  assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.data.ok, false);
  assert.equal(result.data.written, undefined); assert.deepEqual(snapshot(root), before);
  return result.data;
}

test("wiki:14 CLI uses custom registered source folder/scope and explicit slug", async () => {
  const { root, input } = await fresh();
  const file = path.join(root, ".wiki/types/source.json"), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.folder = "observations"; record.scopes = ["projects/demo"]; fs.writeFileSync(file, JSON.stringify(record));
  const result = await success(root, ["capture", input, "--project", "demo", "--title", "知識", "--description", "Explicit source", "--slug", "knowledge"]);
  assert.equal(result.path, "projects/demo/observations/knowledge.md");
  assert.equal(result.original, "projects/demo/assets/knowledge/original.txt");
  await success(root, ["lint"]); await success(root, ["index", "--check"]);
  await refused(root, args(input), 2);
});

for (const [label, bytes, extension, status] of [
  ["invalid UTF-8", Buffer.from([0xff]), ".txt", 5],
  ["unsupported extension", Buffer.from("text"), ".rtf", 5],
] as const) test("wiki:14 CLI extraction refuses " + label + " before even a held mutation lock", async () => {
  const { root, input } = await fresh(bytes, extension);
  fs.writeFileSync(path.join(root, ".wiki/locks/mutation.lock"), "Held by fixture operator");
  await refused(root, args(input), status);
});

for (const [label, tail] of [
  ["missing scope", ["--title", "T", "--description", "D"]],
  ["ambiguous scope", ["--personal", "--project", "demo", "--title", "T", "--description", "D"]],
  ["missing title", ["--personal", "--description", "D"]],
  ["missing description", ["--personal", "--title", "T"]],
  ["invalid project", ["--project", "../escape", "--title", "T", "--description", "D"]],
] as const) test("wiki:14 CLI requires explicit metadata: " + label, async () => {
  const { root, input } = await fresh(); await refused(root, ["capture", input, ...tail], 2);
});
for (const extra of [["--body-file", "ignored"], ["--tags", "tag"], ["--status", "stable"], ["--dry-run"], ["--check"], ["--section", "X"], ["--folder", "x"], ["--unknown"]]) test("wiki:14 CLI rejects command-inapplicable flags " + extra[0], async () => {
  const { root, input } = await fresh(); await refused(root, args(input, ...extra), 2);
});

test("wiki:14 CLI refuses invalid slug and never guesses a collision suffix", async () => {
  const { root, input } = await fresh();
  await refused(root, args(input, "--slug", "../escape"), 2);
  await success(root, args(input));
  await refused(root, args(input), 3);
  await refused(root, args(input, "--title", "Other title", "--slug", "captured-topic"), 3);
});

test("wiki:14 CLI permits identical bytes in distinct explicit captures, not duplicate scoped titles", async () => {
  const { root, input } = await fresh();
  const first = await success(root, args(input));
  await refused(root, args(input, "--slug", "other"), 3);
  const second = await success(root, args(input, "--title", "Other observation", "--slug", "other"));
  assert.equal(first.original_sha256, second.original_sha256); assert.notEqual(first.original, second.original);
  assert.equal(read(root, "log.md").split("**captured**").length - 1, 2);
  await success(root, ["lint"]); await success(root, ["index", "--check"]);
});

test("wiki:14 CLI refuses absent source registration without repair", async () => {
  const { root, input } = await fresh(); fs.unlinkSync(path.join(root, ".wiki/types/source.json"));
  assert.match((await refused(root, args(input), 2)).error.message, /registered source type/);
});

for (const mode of ["registry-folder", "registry-schema", "registry-scope", "registry-missing", "unrelated-damage"]) test("wiki:14 CLI revalidates prepared capture under lock: " + mode, async () => {
  const { root, input } = await fresh();
  const result = await cli(root, args(input), mode);
  assert.equal(result.status, 2, JSON.stringify(result)); assert.equal(result.data.written, undefined);
  assert.ok(result.data.diagnostics.length > 0);
  assert.equal(fs.existsSync(path.join(root, "personal/assets")), false);
  assert.equal(fs.existsSync(path.join(root, "personal/references/captured-topic.md")), false);
  assert.equal(read(root, "log.md"), "");
  assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/locks")), []);
});
for (const mode of ["late-note", "late-asset", "late-duplicate"]) test("wiki:14 CLI refuses destinations or scoped identities introduced before lock: " + mode, async () => {
  const { root, input } = await fresh(); const result = await cli(root, args(input), mode);
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.written, undefined);
  assert.equal(read(root, "log.md"), "");
  if (mode === "late-note") assert.equal(read(root, "personal/references/captured-topic.md"), "External note\n");
});

test("wiki:14 CLI reads input exactly once before lock acquisition and returns human provenance", async () => {
  const { root, input } = await fresh(); assert.equal((await cli(root, args(input), "extract-before-lock")).status, 0);
  const other = await fresh();
  const result = await runCli(["--vault", other.root, ...args(other.input)]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  assert.match(result.stdout, /Captured source: personal\/references\/captured-topic.md/);
  assert.match(result.stdout, /original_sha256: sha256:[0-9a-f]{64}/);
  assert.match(result.stdout, /extractor: wiki:utf8/); assert.match(result.stdout, /retrieved: /);
});

const original = "personal/assets/captured-topic/original.txt", extracted = "personal/assets/captured-topic/extracted.txt", note = "personal/references/captured-topic.md";
for (const mode of ["reserve-race", "reserve-permission"]) test("wiki:14 CLI reservation failure preserves no-publication outcome: " + mode, async () => {
  const { root, input } = await fresh();
  const index = read(root, "index.md");
  try {
    const result = await cli(root, args(input), mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.written, undefined);
    assert.equal(result.data.retainedDirectory, undefined);
    if (mode === "reserve-race") {
      assert.equal(result.status, 3);
      assert.equal(result.data.error.message, "Existing capture destination; no overwrite or suffix performed");
      assert.deepEqual(fs.readdirSync(path.join(root, "personal/assets/captured-topic")), []);
    } else {
      assert.match(result.data.error.message, /EACCES|permission denied/i);
      assert.equal(fs.existsSync(path.join(root, "personal/assets/captured-topic")), false);
    }
    for (const file of [original, extracted, note]) assert.equal(fs.existsSync(path.join(root, file)), false);
    assert.equal(read(root, "index.md"), index);
    assert.equal(read(root, "log.md"), "");
    assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/tmp")), []);
    assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/locks")), []);
  } finally { restore(root); }
});
for (const [mode, expected] of [
  ["asset-fail", [original]], ["note-fail", [original, extracted]],
  ["index-fail", [original, extracted, note]], ["log-fail", [original, extracted, note]],
  ["temporary", [original]], ["temporary-release", [original]], ["note-temporary", [original, extracted, note]],
  ["index-release", [original, extracted, note]],
] as const) test("wiki:14 CLI reports actual retained files and repair steps after " + mode, async () => {
  const { root, input } = await fresh();
  try {
    const result = await cli(root, args(input), mode);
    assert.notEqual(result.status, 0); assert.equal(result.data.ok, false); assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, expected);
    assert.deepEqual(result.data.digests, Object.fromEntries(expected.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])));
    assert.match(result.data.error.message, /inspect.*run index.*log.md/);
    assert.match(result.data.error.message, /EACCES|permission denied/i);
    assert.equal(read(root, "log.md"), "");
    for (const file of [original, extracted, note]) assert.equal(fs.existsSync(path.join(root, file)), new Set<string>(expected).has(file));
    if (mode.includes("temporary")) { assert.equal(result.data.temporaryCleanup.retained, true); assert.equal(fs.existsSync(path.join(root, result.data.temporaryCleanup.path)), true); }
    if (mode.includes("release")) { assert.equal(result.data.cleanup.retained, true); assert.match(result.data.cleanup.message, /EACCES|permission denied/i); }
    else assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/locks")), []);
  } finally { restore(root); }
});

test("wiki:14 CLI reports no publication if first asset cannot be created", async () => {
  const { root, input } = await fresh();
  try {
    const result = await cli(root, args(input), "first-asset-fail");
    assert.notEqual(result.status, 0); assert.equal(result.data.written, undefined);
    assert.equal(result.data.retainedDirectory, "personal/assets/captured-topic");
    assert.ok(result.data.error.message.includes("inspect") && result.data.error.message.includes("personal/assets/captured-topic"));
    for (const file of [original, extracted, note]) assert.equal(fs.existsSync(path.join(root, file)), false);
    assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});

test("wiki:14 CLI preserves primary exclusive conflict and unpublished temporary cleanup failure", async () => {
  const { root, input } = await fresh();
  try {
    const result = await cli(root, args(input), "link-cleanup");
    assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.written, undefined);
    assert.match(result.data.error.message, /EEXIST|Existing/);
    assert.equal(result.data.temporaryCleanup.retained, true); assert.match(result.data.temporaryCleanup.message, /EACCES|permission denied/i);
    assert.equal(read(root, original), "External asset\n");
    assert.equal(fs.existsSync(path.join(root, extracted)), false); assert.equal(fs.existsSync(path.join(root, note)), false);
    assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});

test("wiki:14 CLI emits one final error with all completed metadata on lock cleanup failure", async () => {
  const { root, input } = await fresh();
  try {
    const result = await cli(root, args(input), "release");
    assert.notEqual(result.status, 0); assert.equal(result.data.outcome, "completed"); assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [original, extracted, note]);
    assert.equal(result.data.cleanup.retained, true);
    assert.equal(read(root, "log.md").split("**captured**").length - 1, 1);
    await success(root, ["lint"]); await success(root, ["index", "--check"]);
  } finally { restore(root); }
});

test("wiki:14 CLI keeps primary validation diagnostics when lock cleanup also fails", async () => {
  const { root, input } = await fresh();
  try {
    const result = await cli(root, args(input), "registry-scope-release");
    assert.equal(result.status, 2); assert.equal(result.data.written, undefined);
    assert.ok(result.data.diagnostics.some((d: { rule: string }) => d.rule === "frontmatter.scope"));
    assert.equal(result.data.cleanup.retained, true); assert.equal(read(root, "log.md"), "");
    assert.equal(fs.existsSync(path.join(root, "personal/assets")), false);
  } finally { restore(root); }
});

for (const mode of ["second-link-cleanup", "second-link-cleanup-release"]) test("wiki:14 CLI retains primary conflict and all cleanup failures after original asset: " + mode, async () => {
  const { root, input } = await fresh();
  try {
    const result = await cli(root, args(input), mode);
    assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [original]);
    assert.deepEqual(result.data.digests, { [original]: digest(fs.readFileSync(input)) });
    assert.match(result.data.error.message, /EEXIST|Existing/);
    assert.equal(result.data.temporaryCleanup.retained, true); assert.match(result.data.temporaryCleanup.message, /EACCES|permission denied/i);
    if (mode.endsWith("-release")) assert.equal(result.data.cleanup.retained, true);
    assert.equal(read(root, extracted), "External asset\n"); assert.equal(fs.existsSync(path.join(root, note)), false);
    assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});

test("wiki:14 CLI rejects busy mutation and normalized cross-type title collisions without effects", async () => {
  const { root, input } = await fresh();
  fs.writeFileSync(path.join(root, ".wiki/locks/mutation.lock"), "Held by fixture operator");
  await refused(root, args(input), 3); fs.unlinkSync(path.join(root, ".wiki/locks/mutation.lock"));
  await success(root, ["new", "architecture", "--personal", "--title", "Straße", "--description", "Existing scoped title"]);
  await refused(root, args(input, "--title", " STRASSE ", "--slug", "other"), 3);
  const other = await success(root, ["capture", input, "--project", "demo", "--title", " STRASSE ", "--description", "Other scope", "--slug", "other"]);
  assert.equal(other.path, "projects/demo/references/other.md"); await success(root, ["lint"]); await success(root, ["index", "--check"]);
});


test("wiki:14 CLI human partial output has no success and retains primary failure, paths, digests, and lock cleanup", async () => {
  const { root, input } = await fresh();
  try {
    const guard = fileURLToPath(new URL("./capture-io-guard.js", import.meta.url));
    const result = spawnCli(["--vault", root, ...args(input)], { imports: [guard], cwd: temp, timeout: 15000, env: { HOME: temp, WIKI_CAPTURE_GUARD: "index-release" } });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
    assert.match(result.stderr, /EACCES|permission denied/i); assert.match(result.stderr, /Lock cleanup:/);
    for (const file of [original, extracted, note]) { assert.ok(result.stderr.includes(file)); assert.ok(result.stderr.includes(digest(fs.readFileSync(path.join(root, file))))); }
    assert.equal(result.stderr.includes("Captured source:"), false); assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});
