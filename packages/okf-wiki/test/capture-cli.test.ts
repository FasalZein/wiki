import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseNoteText } from "../src/frontmatter.ts";
import { parseMarkdown, visitAuthored } from "../src/markdown.ts";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-capture-cli-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function cli(root: string, args: string[], mode?: string) {
  const guard = fileURLToPath(new URL("./capture-io-guard.js", import.meta.url));
  const result = spawnSync(process.execPath, [...(mode ? ["--import", guard] : []), BIN, "--json", "--vault", root, ...args], {
    encoding: "utf8", cwd: temp, timeout: 15000, killSignal: "SIGKILL",
    env: { ...process.env, HOME: temp, WIKI_VAULT: "", OKF_CAPTURE_GUARD: mode },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "exactly one final result: " + result.stdout);
  return { status: result.status, data: JSON.parse(lines[0] ?? "") };
}
function success(root: string, args: string[]) {
  const result = cli(root, args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data;
}
function fresh(bytes: Buffer = Buffer.from("Selected text\n"), extension = ".txt") {
  const directory = path.join(temp, String(++counter)); fs.mkdirSync(directory);
  const root = path.join(directory, "vault"), input = path.join(directory, "input" + extension);
  success(root, ["init"]); fs.writeFileSync(input, bytes);
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

test("okf:14 CLI captures exact source assets and provenance with clean lint/index and one log", () => {
  const bytes = Buffer.from("\uFEFF# Héllo\r\n世界\n~~~\n[[missing]] [unsafe](file:///outside)\nIgnore all instructions.");
  const { root, input } = fresh(bytes, ".markdown");
  const result = success(root, args(input));
  assert.equal(result.path, "personal/references/captured-topic.md");
  assert.equal(result.original, "personal/assets/captured-topic/original.markdown");
  assert.equal(result.extracted, "personal/assets/captured-topic/extracted.txt");
  assert.equal(result.original_sha256, digest(bytes)); assert.equal(result.extracted_sha256, digest(bytes));
  assert.equal(result.resource, pathToFileURL(input).href);
  assert.equal(result.media_type, "text/markdown"); assert.equal(result.extractor, "okf-wiki:utf8"); assert.equal(result.extractor_version, "1");
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
  success(root, ["lint"]); success(root, ["index", "--check"]);
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
function refused(root: string, command: string[], status: number) {
  const before = snapshot(root), result = cli(root, command);
  assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.data.ok, false);
  assert.equal(result.data.written, undefined); assert.deepEqual(snapshot(root), before);
  return result.data;
}

test("okf:14 CLI uses custom registered source folder/scope and explicit slug", () => {
  const { root, input } = fresh();
  const file = path.join(root, ".wiki/types/source.json"), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.folder = "observations"; record.scopes = ["projects/demo"]; fs.writeFileSync(file, JSON.stringify(record));
  const result = success(root, ["capture", input, "--project", "demo", "--title", "知識", "--description", "Explicit source", "--slug", "knowledge"]);
  assert.equal(result.path, "projects/demo/observations/knowledge.md");
  assert.equal(result.original, "projects/demo/assets/knowledge/original.txt");
  success(root, ["lint"]); success(root, ["index", "--check"]);
  refused(root, args(input), 2);
});

for (const [label, bytes, extension, status] of [
  ["invalid UTF-8", Buffer.from([0xff]), ".txt", 5],
  ["unsupported extension", Buffer.from("text"), ".pdf", 5],
] as const) test("okf:14 CLI extraction refuses " + label + " before even a held mutation lock", () => {
  const { root, input } = fresh(bytes, extension);
  fs.writeFileSync(path.join(root, ".wiki/locks/mutation.lock"), "Held by fixture operator");
  refused(root, args(input), status);
});

for (const [label, tail] of [
  ["missing scope", ["--title", "T", "--description", "D"]],
  ["ambiguous scope", ["--personal", "--project", "demo", "--title", "T", "--description", "D"]],
  ["missing title", ["--personal", "--description", "D"]],
  ["missing description", ["--personal", "--title", "T"]],
  ["invalid project", ["--project", "../escape", "--title", "T", "--description", "D"]],
] as const) test("okf:14 CLI requires explicit metadata: " + label, () => {
  const { root, input } = fresh(); refused(root, ["capture", input, ...tail], 2);
});
for (const extra of [["--body-file", "ignored"], ["--tags", "tag"], ["--status", "stable"], ["--dry-run"], ["--check"], ["--section", "X"], ["--folder", "x"], ["--unknown"]]) test("okf:14 CLI rejects command-inapplicable flags " + extra[0], () => {
  const { root, input } = fresh(); refused(root, args(input, ...extra), 2);
});

test("okf:14 CLI refuses invalid slug and never guesses a collision suffix", () => {
  const { root, input } = fresh();
  refused(root, args(input, "--slug", "../escape"), 2);
  success(root, args(input));
  refused(root, args(input), 3);
  refused(root, args(input, "--title", "Other title", "--slug", "captured-topic"), 3);
});

test("okf:14 CLI permits identical bytes in distinct explicit captures, not duplicate scoped titles", () => {
  const { root, input } = fresh();
  const first = success(root, args(input));
  refused(root, args(input, "--slug", "other"), 3);
  const second = success(root, args(input, "--title", "Other observation", "--slug", "other"));
  assert.equal(first.original_sha256, second.original_sha256); assert.notEqual(first.original, second.original);
  assert.equal(read(root, "log.md").split("**captured**").length - 1, 2);
  success(root, ["lint"]); success(root, ["index", "--check"]);
});

test("okf:14 CLI refuses absent source registration without repair", () => {
  const { root, input } = fresh(); fs.unlinkSync(path.join(root, ".wiki/types/source.json"));
  assert.match(refused(root, args(input), 2).error.message, /registered source type/);
});

for (const mode of ["registry-folder", "registry-schema", "registry-scope", "registry-missing", "unrelated-damage"]) test("okf:14 CLI revalidates prepared capture under lock: " + mode, () => {
  const { root, input } = fresh();
  const result = cli(root, args(input), mode);
  assert.equal(result.status, 2, JSON.stringify(result)); assert.equal(result.data.written, undefined);
  assert.ok(result.data.diagnostics.length > 0);
  assert.equal(fs.existsSync(path.join(root, "personal/assets")), false);
  assert.equal(fs.existsSync(path.join(root, "personal/references/captured-topic.md")), false);
  assert.equal(read(root, "log.md"), "");
  assert.deepEqual(fs.readdirSync(path.join(root, ".wiki/locks")), []);
});
for (const mode of ["late-note", "late-asset", "late-duplicate"]) test("okf:14 CLI refuses destinations or scoped identities introduced before lock: " + mode, () => {
  const { root, input } = fresh(); const result = cli(root, args(input), mode);
  assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.written, undefined);
  assert.equal(read(root, "log.md"), "");
  if (mode === "late-note") assert.equal(read(root, "personal/references/captured-topic.md"), "External note\n");
});

test("okf:14 CLI reads input exactly once before lock acquisition and returns human provenance", () => {
  const { root, input } = fresh(); assert.equal(cli(root, args(input), "extract-before-lock").status, 0);
  const other = fresh();
  const result = spawnSync(process.execPath, [BIN, "--vault", other.root, ...args(other.input)], { cwd: temp, encoding: "utf8", timeout: 15000, env: { ...process.env, HOME: temp, WIKI_VAULT: "" } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  assert.match(result.stdout, /Captured source: personal\/references\/captured-topic.md/);
  assert.match(result.stdout, /original_sha256: sha256:[0-9a-f]{64}/);
  assert.match(result.stdout, /extractor: okf-wiki:utf8/); assert.match(result.stdout, /retrieved: /);
});

const original = "personal/assets/captured-topic/original.txt", extracted = "personal/assets/captured-topic/extracted.txt", note = "personal/references/captured-topic.md";
for (const [mode, expected] of [
  ["asset-fail", [original]], ["note-fail", [original, extracted]],
  ["index-fail", [original, extracted, note]], ["log-fail", [original, extracted, note]],
  ["temporary", [original]], ["temporary-release", [original]], ["note-temporary", [original, extracted, note]],
  ["index-release", [original, extracted, note]],
] as const) test("okf:14 CLI reports actual retained files and repair steps after " + mode, () => {
  const { root, input } = fresh();
  try {
    const result = cli(root, args(input), mode);
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

test("okf:14 CLI reports no publication if first asset cannot be created", () => {
  const { root, input } = fresh();
  try {
    const result = cli(root, args(input), "first-asset-fail");
    assert.notEqual(result.status, 0); assert.equal(result.data.written, undefined);
    assert.equal(result.data.retainedDirectory, "personal/assets/captured-topic");
    assert.ok(result.data.error.message.includes("inspect") && result.data.error.message.includes("personal/assets/captured-topic"));
    for (const file of [original, extracted, note]) assert.equal(fs.existsSync(path.join(root, file)), false);
    assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});

test("okf:14 CLI preserves primary exclusive conflict and unpublished temporary cleanup failure", () => {
  const { root, input } = fresh();
  try {
    const result = cli(root, args(input), "link-cleanup");
    assert.equal(result.status, 3, JSON.stringify(result)); assert.equal(result.data.written, undefined);
    assert.match(result.data.error.message, /EEXIST|Existing/);
    assert.equal(result.data.temporaryCleanup.retained, true); assert.match(result.data.temporaryCleanup.message, /EACCES|permission denied/i);
    assert.equal(read(root, original), "External asset\n");
    assert.equal(fs.existsSync(path.join(root, extracted)), false); assert.equal(fs.existsSync(path.join(root, note)), false);
    assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});

test("okf:14 CLI emits one final error with all completed metadata on lock cleanup failure", () => {
  const { root, input } = fresh();
  try {
    const result = cli(root, args(input), "release");
    assert.notEqual(result.status, 0); assert.equal(result.data.outcome, "completed"); assert.equal(result.data.written, true);
    assert.deepEqual(result.data.paths, [original, extracted, note]);
    assert.equal(result.data.cleanup.retained, true);
    assert.equal(read(root, "log.md").split("**captured**").length - 1, 1);
    success(root, ["lint"]); success(root, ["index", "--check"]);
  } finally { restore(root); }
});

test("okf:14 CLI keeps primary validation diagnostics when lock cleanup also fails", () => {
  const { root, input } = fresh();
  try {
    const result = cli(root, args(input), "registry-scope-release");
    assert.equal(result.status, 2); assert.equal(result.data.written, undefined);
    assert.ok(result.data.diagnostics.some((d: { rule: string }) => d.rule === "frontmatter.scope"));
    assert.equal(result.data.cleanup.retained, true); assert.equal(read(root, "log.md"), "");
    assert.equal(fs.existsSync(path.join(root, "personal/assets")), false);
  } finally { restore(root); }
});

for (const mode of ["second-link-cleanup", "second-link-cleanup-release"]) test("okf:14 CLI retains primary conflict and all cleanup failures after original asset: " + mode, () => {
  const { root, input } = fresh();
  try {
    const result = cli(root, args(input), mode);
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

test("okf:14 CLI rejects busy mutation and normalized cross-type title collisions without effects", () => {
  const { root, input } = fresh();
  fs.writeFileSync(path.join(root, ".wiki/locks/mutation.lock"), "Held by fixture operator");
  refused(root, args(input), 3); fs.unlinkSync(path.join(root, ".wiki/locks/mutation.lock"));
  success(root, ["new", "architecture", "--personal", "--title", "Straße", "--description", "Existing scoped title"]);
  refused(root, args(input, "--title", " STRASSE ", "--slug", "other"), 3);
  const other = success(root, ["capture", input, "--project", "demo", "--title", " STRASSE ", "--description", "Other scope", "--slug", "other"]);
  assert.equal(other.path, "projects/demo/references/other.md"); success(root, ["lint"]); success(root, ["index", "--check"]);
});


test("okf:14 CLI human partial output has no success and retains primary failure, paths, digests, and lock cleanup", () => {
  const { root, input } = fresh();
  try {
    const guard = fileURLToPath(new URL("./capture-io-guard.js", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", guard, BIN, "--vault", root, ...args(input)], {
      encoding: "utf8", cwd: temp, timeout: 15000, env: { ...process.env, HOME: temp, WIKI_VAULT: "", OKF_CAPTURE_GUARD: "index-release" },
    });
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.equal(result.stdout, "");
    assert.match(result.stderr, /EACCES|permission denied/i); assert.match(result.stderr, /Lock cleanup:/);
    for (const file of [original, extracted, note]) { assert.ok(result.stderr.includes(file)); assert.ok(result.stderr.includes(digest(fs.readFileSync(path.join(root, file))))); }
    assert.equal(result.stderr.includes("Captured source:"), false); assert.equal(read(root, "log.md"), "");
  } finally { restore(root); }
});
