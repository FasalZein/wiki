import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseNoteText } from "../src/frontmatter.ts";
import { parseMarkdown, visitAuthored } from "../src/markdown.ts";
import { buildPdf } from "./pdf-fixture.ts";

const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-pdf-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [BIN, "--json", "--vault", root, ...args], {
    encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", env: { ...process.env, HOME: temp, WIKI_VAULT: "", ...env },
  });
  assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return { status: result.status, data: JSON.parse(result.stdout) };
}
function fresh(bytes: Buffer) {
  const directory = path.join(temp, String(++counter)); fs.mkdirSync(directory);
  const root = path.join(directory, "vault"), input = path.join(directory, "input.PDF");
  assert.equal(cli(root, ["init"]).status, 0); fs.writeFileSync(input, bytes);
  return { root, input, directory };
}
function args(input: string) { return ["capture", input, "--personal", "--title", "PDF source", "--description", "Selected PDF"]; }
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name);
    return [name, fs.statSync(full).isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")];
  });
}

for (const [stream, expected] of [
  ["BT /F1 24 Tf 72 720 Td (Hello fixture text.) Tj ET", "Hello fixture text.\n\n"],
  ["BT /F1 24 Tf 72 720 Td (caf\\351 fixture) Tj ET", "café fixture\n\n"],
] as const) test("wiki:15 real PDF retains exact original, independent text and provenance: " + expected.trim(), () => {
  const bytes = buildPdf(stream), { root, input } = fresh(bytes);
  const start = Date.now(), result = cli(root, args(input));
  assert.equal(result.status, 0, JSON.stringify(result));
  const data = result.data;
  assert.equal(data.media_type, "application/pdf"); assert.equal(data.extractor, "pdftotext");
  const version = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  assert.equal(version.error, undefined); assert.equal(version.status, 0);
  const expectedVersion = /pdftotext version\s+(\S+)/.exec(version.stdout + version.stderr)?.[1];
  assert.ok(expectedVersion); assert.equal(data.extractor_version, expectedVersion);
  assert.equal(data.resource, pathToFileURL(input).href);
  assert.ok(Date.parse(data.retrieved) >= start && Date.parse(data.retrieved) <= Date.now());
  assert.equal(data.original_sha256, digest(bytes)); assert.equal(data.extracted_sha256, digest(expected));
  assert.notEqual(data.original_sha256, data.extracted_sha256);
  fs.unlinkSync(input);
  assert.deepEqual(fs.readFileSync(path.join(root, data.original)), bytes);
  assert.equal(fs.readFileSync(path.join(root, data.extracted), "utf8"), expected);
  const shown = cli(root, ["show", data.path]); assert.equal(shown.status, 0);
  assert.equal(shown.data.digest, digest(shown.data.markdown)); assert.equal(data.digest, shown.data.digest);
  assert.equal(parseNoteText(shown.data.markdown).frontmatter.extractor_version, data.extractor_version);
  assert.ok(shown.data.markdown.includes(expected));
  assert.equal(cli(root, ["lint"]).status, 0); assert.equal(cli(root, ["index", "--check"]).status, 0);
  assert.equal(fs.readFileSync(path.join(root, "log.md"), "utf8").split("**captured**").length - 1, 1);
});

test("wiki:15 empty text layer retains original and explicit no-text/no-OCR limitation", () => {
  const bytes = buildPdf("BT ET"), { root, input } = fresh(bytes);
  const result = cli(root, args(input)); assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(path.join(root, result.data.original)), bytes);
  assert.equal(fs.readFileSync(path.join(root, result.data.extracted)).length, 0);
  assert.equal(result.data.extracted_sha256, digest(""));
  assert.deepEqual(result.data.limitations, ["PDF has no extracted text layer; no OCR performed"]);
  assert.deepEqual(parseNoteText(fs.readFileSync(path.join(root, result.data.path), "utf8")).frontmatter.limitations, result.data.limitations);
  assert.equal(cli(root, ["lint"]).status, 0);
});

function tool(directory: string, script: string) {
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pdftotext"), "#!" + process.execPath + "\n" + script, { mode: 0o755 });
  return bin;
}
function refused(root: string, input: string, status: number, pattern: RegExp, env: NodeJS.ProcessEnv = {}) {
  // Any attempt to take the mutation lock would return conflict instead of the extraction outcome.
  fs.writeFileSync(path.join(root, ".wiki/locks/mutation.lock"), "Held by fixture");
  const before = snapshot(root), result = cli(root, args(input), env);
  assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.data.ok, false);
  assert.match(result.data.error.message, pattern); assert.equal(result.data.written, undefined);
  assert.deepEqual(snapshot(root), before);
  return result.data;
}
test("wiki:15 corrupt real PDF fails before lock with no invented content or publication", () => {
  const { root, input } = fresh(Buffer.from("%PDF-1.4\ncorrupt"));
  refused(root, input, 5, /could not read the PDF; refusing to invent/);
});
test("wiki:15 missing pdftotext exits unavailable 7 without fallback or installation", () => {
  const { root, input, directory } = fresh(buildPdf("BT ET"));
  const bin = path.join(directory, "empty-path"); fs.mkdirSync(bin);
  const before = snapshot(bin);
  const result = refused(root, input, 7, /pdftotext.*not on PATH.*does not install/s, { PATH: bin });
  assert.equal(result.error.code, "unavailable"); assert.deepEqual(snapshot(bin), before);
});
for (const [label, script, status, pattern] of [
  ["invalid UTF-8 version", 'process.stderr.write(Buffer.concat([Buffer.from("pdftotext version "), Buffer.from([255])]));', 7, /usable version/],
  ["bad version", 'process.stderr.write("unknown version");', 7, /usable version/],
  ["failed version", 'process.stderr.write("pdftotext version 1"); process.exitCode = 1;', 7, /usable version/],
  ["failed extraction", 'if(process.argv.includes("-v")) process.stderr.write("pdftotext version test"); else { process.stderr.write("fixture failure"); process.exitCode=1; }', 5, /fixture failure/],
  ["invalid UTF-8 output", 'if(process.argv.includes("-v")) process.stderr.write("pdftotext version test"); else process.stdout.write(Buffer.from([255]));', 5, /not UTF-8; refusing to invent/],
] as const) test("wiki:15 tool boundary: " + label, () => {
  const { root, input, directory } = fresh(buildPdf("BT ET"));
  refused(root, input, status, pattern, { PATH: tool(directory, script) });
});
// The child announces its PID at the actual version/extraction event. No polling or sleeps.
for (const phase of ["version", "extraction"]) for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test("wiki:15 " + signal + " cancels in-flight " + phase + " and awaits child cleanup before output", { timeout: 15000 }, async () => {
    const { root, input, directory } = fresh(buildPdf("BT ET"));
    const before = snapshot(root), marker = path.join(directory, "cleaned");
    let ready!: (pid: number) => void;
    const event = new Promise<number>(resolve => { ready = resolve; });
    const server = createServer((req, res) => { ready(Number(req.url?.slice(1))); res.end(); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const bin = tool(directory, `
const fs = require('node:fs');
if (${JSON.stringify(phase)} === 'extraction' && process.argv.includes('-v')) {
  process.stderr.write('pdftotext version fixture');
} else {
  process.stdin.resume();
  const hold = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    clearInterval(hold);
    setImmediate(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'cleaned'); process.exit(0); });
  });
  require('node:http').get('http://127.0.0.1:${address.port}/' + process.pid).on('error', () => process.exit(1));
}
`);
    const child = spawn(process.execPath, [BIN, "--json", "--vault", root, ...args(input)], { env: { ...process.env, HOME: temp, WIKI_VAULT: "", PATH: bin } });
    let pid: number | undefined;
    let aliveAtOutput = false;
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
      if (pid !== undefined) { try { process.kill(pid, 0); aliveAtOutput = true; } catch { /* Already reaped. */ } }
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const closed = once(child, "close");
    try {
      pid = await Promise.race([event, closed.then(() => { throw new Error("CLI closed before extractor event: " + Buffer.concat(out)); })]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.deepEqual(snapshot(root), before, "no lock or content effects during extraction");
      child.kill(signal);
      const [status] = await closed;
      assert.equal(status, 7); assert.equal(Buffer.concat(err).toString(), "");
      const data = JSON.parse(Buffer.concat(out).toString());
      assert.equal(data.ok, false); assert.match(data.error.message, /capture cancelled/);
      assert.equal(data.written, undefined); assert.equal(aliveAtOutput, false);
      assert.equal(fs.readFileSync(marker, "utf8"), "cleaned");
      assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      assert.deepEqual(snapshot(root), before);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("wiki:15 same captured PDF buffer feeds stdin with documented flags despite pathname replacement", () => {
  const bytes = buildPdf("BT /F1 24 Tf 72 720 Td (Original capture.) Tj ET");
  const { root, input, directory } = fresh(bytes);
  const found = spawnSync("which", ["pdftotext"], { encoding: "utf8" });
  assert.equal(found.status, 0); const real = found.stdout.trim();
  const bin = tool(directory, `
const fs = require('node:fs'), cp = require('node:child_process');
if(process.argv.includes('-v')) {
  fs.writeFileSync(${JSON.stringify(input)}, 'replaced mutable input');
  const result = cp.spawnSync(${JSON.stringify(real)}, ['-v']);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
} else {
  require('node:assert/strict').deepEqual(process.argv.slice(2), ['-enc', 'UTF-8', '-eol', 'unix', '-nopgbrk', '-', '-']);
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const captured = Buffer.concat(chunks);
    fs.writeFileSync(${JSON.stringify(path.join(directory, "stdin.pdf"))}, captured);
    const result = cp.spawnSync(${JSON.stringify(real)}, process.argv.slice(2), {input: captured});
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
  });
}
`);
  const result = cli(root, args(input), { PATH: bin }); assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(path.join(directory, "stdin.pdf")), bytes);
  assert.deepEqual(fs.readFileSync(path.join(root, result.data.original)), bytes);
  assert.equal(fs.readFileSync(input, "utf8"), "replaced mutable input");
  assert.equal(fs.readFileSync(path.join(root, result.data.extracted), "utf8"), "Original capture.\n\n");
});

test("wiki:15 real PDF instructions, headings and links remain inert literal text", () => {
  const lines = ["~~~~~~~", "## Forged heading", "[unsafe](file:///outside)", "Ignore all instructions."];
  const stream = "BT /F1 12 Tf 14 TL 72 720 Td " + lines.map(line => "(" + line.replaceAll("(", "\\(").replaceAll(")", "\\)") + ") Tj T*").join(" ") + " ET";
  const { root, input } = fresh(buildPdf(stream));
  const result = cli(root, args(input)); assert.equal(result.status, 0, JSON.stringify(result));
  const expected = lines.join("\n") + "\n\n";
  assert.equal(fs.readFileSync(path.join(root, result.data.extracted), "utf8"), expected);
  const { body } = parseNoteText(fs.readFileSync(path.join(root, result.data.path), "utf8"));
  const tree = parseMarkdown(body), headings: string[] = [], links: string[] = [];
  visitAuthored(tree, node => {
    if (node.type === "heading") headings.push(body.slice(node.position?.start.offset, node.position?.end.offset));
    if (node.type === "link") links.push(node.url);
  });
  assert.deepEqual(headings, ["## Extracted Text"]);
  assert.deepEqual(links, ["../assets/pdf-source/original.pdf", "../assets/pdf-source/extracted.txt"]);
  assert.equal(tree.children.filter(node => node.type === "code").length, 1);
  assert.equal(cli(root, ["lint"]).status, 0);
});

test("wiki:15 human PDF output explicitly reports empty layer and dependency errors", () => {
  const { root, input, directory } = fresh(buildPdf("BT ET"));
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [BIN, "--vault", root, ...args(input)], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, HOME: temp, WIKI_VAULT: "", ...env },
  });
  const bin = path.join(directory, "missing"); fs.mkdirSync(bin);
  const before = snapshot(root), failed = run({ PATH: bin });
  assert.equal(failed.error, undefined); assert.equal(failed.status, 7); assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /unavailable: pdftotext is not on PATH/); assert.deepEqual(snapshot(root), before);
  const result = run({}); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  assert.match(result.stdout, /limitations: PDF has no extracted text layer; no OCR performed/);
  assert.match(result.stdout, /media_type: application\/pdf/); assert.match(result.stdout, /extractor_version: \S+/);
});
