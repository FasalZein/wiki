import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseNoteText } from "../src/frontmatter.ts";
import { buildPdf } from "./pdf-fixture.ts";

const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-web-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function fresh() {
  const directory = path.join(temp, String(++counter)); fs.mkdirSync(directory);
  const root = path.join(directory, "vault");
  const init = spawnSync(process.execPath, [BIN, "init", root, "--json"], { encoding: "utf8", env: { ...process.env, HOME: temp, WIKI_VAULT: "" } });
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return { root, directory };
}
function args(input: string) { return ["capture", input, "--personal", "--title", "Web source", "--description", "Selected resource"]; }
function start(root: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [BIN, "--json", "--vault", root, ...argv], { env: { ...process.env, HOME: temp, WIKI_VAULT: "", ...env } });
  const out: Buffer[] = [], err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk)); child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const closed = once(child, "close");
  const result = closed.then(([status]) => {
    assert.equal(Buffer.concat(err).toString(), "");
    const stdout = Buffer.concat(out).toString(); assert.equal(stdout.trim().split("\n").length, 1, stdout);
    return { status, data: JSON.parse(stdout) };
  });
  return { child, closed, result };
}
async function cli(root: string, argv: string[], env: NodeJS.ProcessEnv = {}) { return start(root, argv, env).result; }
async function serve(respond: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: { url: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((req, res) => { hits.push({ url: req.url ?? "", headers: req.headers }); respond(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { origin: "http://127.0.0.1:" + address.port, hits, server,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => { const full = path.join(dir, name); return [name, fs.statSync(full).isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")]; });
}

test("wiki:16 plain HTTP capture retains exact bytes, independent text and provenance after server stop", { timeout: 15000 }, async () => {
  const { root } = fresh(), bytes = Buffer.from("Complete fixture text.\r\nNo final newline");
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(bytes); });
  try {
    const time = Date.now(), result = await cli(root, args(fixture.origin + "/plain"));
    assert.equal(result.status, 0, JSON.stringify(result));
    const data = result.data;
    assert.equal(data.resource, fixture.origin + "/plain"); assert.equal(data.final_resource, undefined);
    assert.ok(Date.parse(data.retrieved) >= time && Date.parse(data.retrieved) <= Date.now());
    assert.equal(data.media_type, "text/plain"); assert.equal(data.extractor, "text-decoder"); assert.equal(data.extractor_version, process.versions.node);
    assert.equal(data.original_sha256, digest(bytes)); assert.equal(data.extracted_sha256, digest("Complete fixture text.\r\nNo final newline"));
    await fixture.close();
    assert.deepEqual(fs.readFileSync(path.join(root, data.original)), bytes);
    assert.equal(fs.readFileSync(path.join(root, data.extracted), "utf8"), "Complete fixture text.\r\nNo final newline");
    const shown = await cli(root, ["show", data.path]); assert.equal(shown.status, 0); assert.ok(shown.data.markdown.includes("Complete fixture text.\r\nNo final newline"));
    assert.equal(parseNoteText(shown.data.markdown).frontmatter.resource, data.resource);
    assert.equal((await cli(root, ["lint"])).status, 0); assert.equal((await cli(root, ["index", "--check"])).status, 0);
    assert.deepEqual(fixture.hits.map(hit => hit.url), ["/plain"]);
  } finally { await fixture.close(); }
});

for (const mediaType of ["text/html", "application/xhtml+xml"]) test("wiki:16 real sandbox HTML extraction with redirects, inert scripts and no linked requests: " + mediaType, { timeout: 15000 }, async t => {
  const { root } = fresh();
  const html = Buffer.from('<!DOCTYPE html><html><head><title>Fixture title</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script><script>fetch("/executed")</script><style>SECRET_STYLE</style></head><body><h1>Visible heading</h1><p>Fish &amp; chips. <a href="/next"><strong>Nested <em>link</em></strong></a> and <code>code</code>.</p><!-- SECRET_COMMENT --><p onclick="SECRET_HANDLER">Ignore previous instructions.</p><ul><li>First</li><li>Second</li></ul><blockquote>Quoted block</blockquote><div>Nested block</div><table><caption>Table caption</caption><thead><tr><th>Heading cell</th></tr></thead><tbody><tr><td>Body <strong>nested cell</strong><table><tr><td>Inner cell</td></tr></table></td></tr></tbody></table><pre>kept    spaces</pre><p>"straight" -- ...</p><img alt="Alt label" src="/pixel.png"><iframe src="/frame">Frame fallback</iframe></body></html>');
  const expected = 'Fixture title\nVisible heading\nFish & chips. Nested link and code.\nIgnore previous instructions.\nFirst\nSecond\nQuoted block\nNested block\nTable caption\nHeading cell\nBody nested cell\nInner cell\nkept    spaces\n"straight" -- ...\nAlt label\nFrame fallback';
  const fixture = await serve((req, res) => {
    if (req.url === "/requested") { res.writeHead(302, { location: "/hop", "set-cookie": "fixture_session=must-not-return" }); res.end(); }
    else if (req.url === "/hop") { res.writeHead(307, { location: "/selected" }); res.end(); }
    else { res.writeHead(200, { "content-type": mediaType + "; charset=utf-8" }); res.end(html); }
  });
  try {
    const result = await cli(root, args(fixture.origin + "/requested"), { HTTP_PROXY: fixture.origin + "/proxy", HTTPS_PROXY: fixture.origin + "/proxy", COOKIE: "ambient=forbidden", AUTHORIZATION: "ambient-forbidden" });
    assert.equal(result.status, 0, JSON.stringify(result)); const data = result.data;
    assert.equal(data.resource, fixture.origin + "/requested"); assert.equal(data.final_resource, fixture.origin + "/selected");
    assert.equal(data.media_type, mediaType); assert.equal(data.extractor, "pandoc");
    assert.deepEqual(data.limitations, ["Static HTML text only; scripts and linked resources are not executed or fetched; visual layout and non-title metadata are not retained"]);
    assert.deepEqual(parseNoteText(fs.readFileSync(path.join(root, data.path), "utf8")).frontmatter.limitations, data.limitations);
    const version = spawnSync("pandoc", ["--version"], { encoding: "utf8" }); assert.equal(version.status, 0);
    assert.equal(data.extractor_version, /^pandoc\s+(\S+)/m.exec(version.stdout)?.[1]);
    assert.equal(data.original_sha256, digest(html)); assert.equal(data.extracted_sha256, digest(expected));
    assert.deepEqual(fs.readFileSync(path.join(root, data.original)), html);
    assert.equal(fs.readFileSync(path.join(root, data.extracted), "utf8"), expected);
    assert.deepEqual(fixture.hits.map(hit => hit.url), ["/requested", "/hop", "/selected"]);
    for (const hit of fixture.hits) { assert.equal(hit.headers.cookie, undefined); assert.equal(hit.headers.authorization, undefined); assert.equal(hit.headers["proxy-authorization"], undefined); }
    t.diagnostic(JSON.stringify({ mediaType, extractor: data.extractor, version: data.extractor_version, requests: fixture.hits.map(hit => ({ url: hit.url, cookie: hit.headers.cookie !== undefined, authorization: hit.headers.authorization !== undefined, proxyAuthorization: hit.headers["proxy-authorization"] !== undefined })) }));
    await fixture.close();
    assert.equal((await cli(root, ["show", data.path])).status, 0);
    assert.equal((await cli(root, ["lint"])).status, 0);
  } finally { await fixture.close(); }
});

for (const [stream, expected] of [["BT /F1 24 Tf 72 720 Td (caf\\351 fixture) Tj ET", "café fixture\n\n"], ["BT ET", ""]] as const) test("wiki:16 HTTP PDF uses captured bytes and real pdftotext: " + (expected || "empty layer"), { timeout: 15000 }, async () => {
  const { root } = fresh(), bytes = buildPdf(stream);
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": "application/pdf" }); res.end(bytes); });
  try {
    const result = await cli(root, args(fixture.origin + "/pdf")); assert.equal(result.status, 0, JSON.stringify(result));
    const data = result.data;
    assert.equal(data.media_type, "application/pdf"); assert.equal(data.extractor, "pdftotext");
    const version = spawnSync("pdftotext", ["-v"], { encoding: "utf8" }); assert.equal(version.status, 0);
    assert.equal(data.extractor_version, /pdftotext version\s+(\S+)/.exec(version.stdout + version.stderr)?.[1]);
    assert.equal(data.original_sha256, digest(bytes)); assert.equal(data.extracted_sha256, digest(expected));
    assert.deepEqual(fs.readFileSync(path.join(root, data.original)), bytes);
    assert.equal(fs.readFileSync(path.join(root, data.extracted), "utf8"), expected);
    if (!expected) assert.deepEqual(data.limitations, ["PDF has no extracted text layer; no OCR performed"]);
    await fixture.close(); assert.equal((await cli(root, ["show", data.path])).status, 0);
    assert.deepEqual(fixture.hits.map(hit => hit.url), ["/pdf"]);
  } finally { await fixture.close(); }
});

const latin = (s: string) => Buffer.from(s, "latin1");
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const meta = '<meta charset="iso-8859-1">';
const quotedMeta = '<meta data-note="a>b" charset="windows-1252">';
// The declaration's closing > must be inside the byte prefix, not merely its opening <.
const charsetCases: [string, string, Buffer, string | RegExp][] = [
  ["repair quoted greater-than before charset", "text/html", latin('<meta data-note="a>b" charset="windows-1252"><p>café</p>'), "café"],
  ["repair real tag end beyond prefix", "text/html", Buffer.from('<meta charset="windows-1252" data-note=">' + " ".repeat(1024) + '"><p>café</p>'), "café"],
  ["repair meta-looking attribute text", "text/html", Buffer.from(`<div title='<meta charset="windows-1252">'></div><p>café</p>`), "café"],
  ["repair quoted MIME parameter", 'text/plain; note="abc; charset=windows-1252; xyz"; charset=utf-8', Buffer.from("café"), "café"],
  ["adjacent single-quoted tag attribute", "text/html", latin("<meta data-note='a>b' charset='windows-1252'><p>café</p>"), "café"],
  ["adjacent quoted tag ends at byte 1024", "text/html", latin(" ".repeat(1024 - quotedMeta.length) + quotedMeta + "<p>café</p>"), "café"],
  ["adjacent quoted tag ends after byte 1024", "text/html", latin(" ".repeat(1025 - quotedMeta.length) + quotedMeta + "<p>café</p>"), /bytes are not valid utf-8/],
  ["adjacent double-quoted outer attribute", "text/html", Buffer.from(`<div title="<meta charset='windows-1252'>"></div><p>café</p>`), "café"],
  ["adjacent charset text inside meta attribute", "text/html", Buffer.from('<meta data-note="a charset=windows-1252 >"><p>café</p>'), "café"],
  ["adjacent escaped MIME quote", String.raw`text/plain; note="abc\"; charset=windows-1252; xyz"; charset=utf-8`, Buffer.from("café"), "café"],
  ["adjacent quoted transport charset", 'text/plain; note="a;b"; charset="utf-8"', Buffer.from("café"), "café"],
  ["adjacent empty transport charset", 'text/plain; charset=""', Buffer.from("café"), "café"],
  ["adjacent malformed MIME type", "text/plain/extra; charset=utf-8", Buffer.from("café"), /Invalid Content-Type/],
  ["transport", "text/html; charset=iso-8859-1", latin('<meta charset="utf-8"><p>café</p>'), "café"],
  ["WHATWG legacy label", "text/html; charset=iso-8859-1", latin("<p>price \x80</p>"), "price €"],
  ["meta", "text/html", latin(meta + "<p>café</p>"), "café"],
  ["http-equiv meta", "text/html", latin('<meta http-equiv="content-type" content="text/html; charset=windows-1252"><p>café</p>'), "café"],
  ["BOM beats transport and meta", "text/html; charset=iso-8859-1", Buffer.concat([utf8Bom, Buffer.from(meta + "<p>café</p>")]), "café"],
  ["unsupported transport falls back to meta", "text/html; charset=not-an-encoding", latin(meta + "<p>café</p>"), "café"],
  ["unsupported transport falls back to UTF8", "text/html; charset=not-an-encoding", Buffer.from("<p>café</p>"), "café"],
  ["commented charset", "text/html", Buffer.from('<!-- <meta charset="windows-1252"> --><meta charset="utf-8"><p>café</p>'), "café"],
  ["commented http-equiv", "text/html", Buffer.from('<!-- <meta http-equiv="content-type" content="text/html; charset=windows-1252"> --><p>café</p>'), "café"],
  ["meta ends at byte 1024", "text/html", latin(" ".repeat(1024 - meta.length) + meta + "<p>café</p>"), "café"],
  ["meta ends after byte 1024", "text/html", latin(" ".repeat(1025 - meta.length) + meta + "<p>café</p>"), /bytes are not valid utf-8/],
  ["late meta", "text/html", latin(" ".repeat(1100) + meta + "<p>café</p>"), /bytes are not valid utf-8/],
  ["valid transport beats meta", "text/html; charset=utf-8", latin(meta + "<p>café</p>"), /bytes are not valid utf-8/],
  ["unknown meta", "text/html", Buffer.from('<meta charset="not-an-encoding"><p>text</p>'), /unsupported character encoding/],
  ["plain charset", "text/plain; charset=windows-1252", latin("café\r\n"), "café\r\n"],
  ["plain unknown charset", "text/plain; charset=not-an-encoding", Buffer.from("text"), /unsupported character encoding/],
  ["plain invalid UTF8", "text/plain", Buffer.from([255]), /bytes are not valid utf-8/],
  ["plain UTF16LE BOM", "text/plain; charset=utf-8", Buffer.concat([Buffer.from([255, 254]), Buffer.from("café", "utf16le")]), "café"],
  ["plain UTF16BE BOM", "text/plain", Buffer.from([254, 255, 0, 99, 0, 97, 0, 102, 0, 233]), "café"],
];
for (const [label, contentType, bytes, expected] of charsetCases) test("wiki:16 charset: " + label, { timeout: 15000 }, async () => {
  const { root } = fresh();
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": contentType }); res.end(bytes); });
  try {
    if (expected instanceof RegExp) await refused(root, fixture.origin + "/charset", 5, expected);
    else {
      const result = await cli(root, args(fixture.origin + "/charset")); assert.equal(result.status, 0, JSON.stringify(result));
      assert.deepEqual(fs.readFileSync(path.join(root, result.data.extracted)), Buffer.from(expected, "utf8"));
      assert.equal(result.data.ok, true); assert.equal(result.data.written, true);
      assert.equal(result.data.original_sha256, digest(bytes)); assert.equal(result.data.extracted_sha256, digest(expected));
      assert.deepEqual(fs.readFileSync(path.join(root, result.data.original)), bytes);
    }
    assert.deepEqual(fixture.hits.map(hit => hit.url), ["/charset"]);
  } finally { await fixture.close(); }
});

async function refused(root: string, input: string, status: number, pattern: RegExp, env: NodeJS.ProcessEnv = {}) {
  fs.writeFileSync(path.join(root, ".wiki/locks/mutation.lock"), "Held by fixture");
  const before = snapshot(root), result = await cli(root, args(input), env);
  assert.equal(result.status, status, JSON.stringify(result)); assert.equal(result.data.ok, false);
  assert.match(result.data.error.message, pattern); assert.equal(result.data.written, undefined);
  assert.deepEqual(snapshot(root), before, "failed preparation must not publish or acquire a mutation lock");
  return result.data;
}

for (const [label, status, headers, body, expectedStatus, pattern] of [
  ["HTTP 404", 404, { "content-type": "text/plain" }, "missing", 7, /HTTP 404/],
  ["HTTP 500", 500, { "content-type": "text/plain" }, "failed", 7, /HTTP 500/],
  ["unsupported media", 200, { "content-type": "application/json" }, "{}", 5, /media type application\/json/],
  ["missing media", 200, {}, "text", 5, /media type application\/octet-stream/],
  ["corrupt PDF", 200, { "content-type": "application/pdf" }, "%PDF-1.4 corrupt", 5, /could not read the PDF/],
  ["file redirect", 302, { location: "file:///must-not-open" }, "", 5, /only HTTP\/HTTPS/],
  ["FTP redirect", 302, { location: "ftp://127.0.0.1/must-not-fetch" }, "", 5, /only HTTP\/HTTPS/],
  ["data redirect", 302, { location: "data:text/plain,must-not-read" }, "", 5, /only HTTP\/HTTPS/],
  ["credential redirect", 302, { location: "http://fixture:secret@127.0.0.1/must-not-fetch" }, "", 5, /URL credentials/],
  ["missing Location", 302, {}, "", 7, /no Location/],
  ["invalid Location", 302, { location: "http://[" }, "", 7, /request\/body failed/],
] as const) test("wiki:16 no publication on " + label, { timeout: 15000 }, async () => {
  const { root } = fresh();
  const fixture = await serve((_req, res) => { res.writeHead(status, headers); res.end(body); });
  try { await refused(root, fixture.origin + "/failure", expectedStatus, pattern); assert.deepEqual(fixture.hits.map(hit => hit.url), ["/failure"]); }
  finally { await fixture.close(); }
});
for (const input of ["file:///must-not-open", "ftp://127.0.0.1/must-not-fetch", "data:text/plain,not-a-resource", "http://fixture:secret@127.0.0.1/", "http://["]) test("wiki:16 refuse explicit invalid scheme/URL/credentials: " + input.split(":")[0] + (input.includes("@") ? " credentials" : ""), async () => {
  const { root } = fresh(); await refused(root, input, 5, /HTTP\/HTTPS|URL credentials/);
});
test("wiki:16 redirect cycle uses only the Fetch Standard redirect bound, never retries", { timeout: 15000 }, async () => {
  const { root } = fresh();
  const fixture = await serve((_req, res) => { res.writeHead(302, { location: "/cycle" }); res.end(); });
  try { await refused(root, fixture.origin + "/cycle", 7, /Fetch Standard redirect limit/); assert.equal(fixture.hits.length, 21); }
  finally { await fixture.close(); }
});
test("wiki:16 interrupted response body fails before publication", { timeout: 15000 }, async () => {
  const { root } = fresh();
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/plain", "content-length": "100" }); res.write("partial"); res.destroy(); });
  try { await refused(root, fixture.origin + "/body", 7, /request\/body failed/); assert.equal(fixture.hits.length, 1); }
  finally { await fixture.close(); }
});
function tool(directory: string, command: string, script: string) {
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, command), "#!" + process.execPath + "\n" + script, { mode: 0o755 });
  return bin;
}
for (const [command, mediaType, bytes] of [["pandoc", "text/html", Buffer.from("<p>text</p>")], ["pdftotext", "application/pdf", buildPdf("BT ET")]] as const) test("wiki:16 missing " + command + " is unavailable 7 without installation", { timeout: 15000 }, async () => {
  const { root, directory } = fresh(), bin = path.join(directory, "empty-path"); fs.mkdirSync(bin);
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": mediaType }); res.end(bytes); });
  try { await refused(root, fixture.origin + "/missing", 7, /not on PATH.*does not install/, { PATH: bin }); assert.deepEqual(fs.readdirSync(bin), []); }
  finally { await fixture.close(); }
});
for (const [label, script, status, pattern] of [
  ["bad version", 'process.stdout.write("unknown version");', 7, /usable version/],
  ["nonzero version", 'process.stdout.write("pandoc 1"); process.exitCode=1;', 7, /usable version/],
  ["invalid UTF8 version", 'process.stdout.write(Buffer.concat([Buffer.from("pandoc "), Buffer.from([255])]));', 7, /usable version/],
  ["nonzero extraction", 'process.stderr.write("fixture tool failure"); process.exitCode=1;', 5, /fixture tool failure/],
  ["non-JSON output", 'process.stdout.write("not JSON");', 5, /did not return JSON/],
  ["non-UTF8 output", 'process.stdout.write(Buffer.from([255]));', 5, /not UTF-8/],
  ["unknown AST block", 'process.stdout.write(JSON.stringify({meta:{},blocks:[{t:"FutureBlock",c:[]}]}));', 5, /FutureBlock.*refusing/],
  ["unknown AST inline", 'process.stdout.write(JSON.stringify({meta:{},blocks:[{t:"Para",c:[{t:"FutureInline",c:[]}]}]}));', 5, /FutureInline.*refusing/],
] as const) test("wiki:16 Pandoc failure boundary: " + label, { timeout: 15000 }, async () => {
  const { root, directory } = fresh();
  const bin = tool(directory, "pandoc", label.includes("version") ? script : 'if(process.argv.includes("--version")) process.stdout.write("pandoc fixture"); else { ' + script + ' }');
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>text</p>"); });
  try { await refused(root, fixture.origin + "/tool", status, pattern, { PATH: bin }); assert.equal(fixture.hits.length, 1); }
  finally { await fixture.close(); }
});

for (const phase of ["request", "body"]) for (const signal of ["SIGINT", "SIGTERM"] as const) test("wiki:16 " + signal + " cancels in-flight HTTP " + phase + " without publication", { timeout: 15000 }, async () => {
  const { root } = fresh(), before = snapshot(root);
  let ready!: () => void;
  const event = new Promise<void>(resolve => { ready = resolve; });
  let disconnected!: () => void;
  const connectionClosed = new Promise<void>(resolve => { disconnected = resolve; });
  const fixture = await serve((req, res) => {
    res.on("close", disconnected);
    if (phase === "body") { res.writeHead(200, { "content-type": "text/plain" }); res.write("incomplete body"); }
    ready();
  });
  const run = start(root, args(fixture.origin + "/cancel"));
  try {
    await Promise.race([event, run.closed.then(() => { throw new Error("CLI closed before request event"); })]);
    assert.deepEqual(snapshot(root), before, "no mutation lock while waiting for network");
    run.child.kill(signal);
    const result = await run.result; assert.equal(result.status, 7, JSON.stringify(result));
    assert.match(result.data.error.message, /capture cancelled/); assert.equal(result.data.written, undefined);
    await connectionClosed;
    assert.deepEqual(snapshot(root), before); assert.equal(fixture.hits.length, 1);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill("SIGKILL"); await run.closed; }
    await fixture.close();
  }
});

for (const command of ["pandoc", "pdftotext"]) for (const phase of ["version", "extraction"]) for (const signal of ["SIGINT", "SIGTERM"] as const) test("wiki:16 " + signal + " cancels web " + command + " " + phase + " and awaits direct-child cleanup", { timeout: 15000 }, async () => {
  const { root, directory } = fresh(), before = snapshot(root), marker = path.join(directory, "cleaned");
  let ready!: (pid: number) => void;
  const event = new Promise<number>(resolve => { ready = resolve; });
  const announcements = await serve((req, res) => { ready(Number(req.url?.slice(1))); res.end(); });
  const bin = tool(directory, command, `
const fs = require("node:fs");
if (${JSON.stringify(phase)} === "extraction" && (process.argv.includes("--version") || process.argv.includes("-v"))) {
  process.stdout.write(${JSON.stringify(command === "pandoc" ? "pandoc fixture" : "pdftotext version fixture")});
} else {
  process.stdin.resume();
  const hold = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    clearInterval(hold);
    setImmediate(() => { fs.writeFileSync(${JSON.stringify(marker)}, "cleaned"); process.exit(0); });
  });
  require("node:http").get(${JSON.stringify(announcements.origin)} + "/" + process.pid).on("error", () => process.exit(1));
}
`);
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": command === "pandoc" ? "text/html" : "application/pdf" }); res.end(command === "pandoc" ? Buffer.from("<p>text</p>") : buildPdf("BT ET")); });
  const run = start(root, args(fixture.origin + "/selected"), { PATH: bin });
  let pid: number | undefined, aliveAtOutput = false;
  run.child.stdout.on("data", () => { if (pid !== undefined) { try { process.kill(pid, 0); aliveAtOutput = true; } catch { /* Already reaped. */ } } });
  try {
    pid = await Promise.race([event, run.closed.then(() => { throw new Error("CLI closed before tool event"); })]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.deepEqual(snapshot(root), before, "no mutation lock during extractor/version probe");
    run.child.kill(signal);
    const result = await run.result; assert.equal(result.status, 7, JSON.stringify(result));
    assert.match(result.data.error.message, /capture cancelled/); assert.equal(result.data.written, undefined);
    assert.equal(aliveAtOutput, false); assert.equal(fs.readFileSync(marker, "utf8"), "cleaned");
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }); assert.deepEqual(snapshot(root), before);
    assert.deepEqual(fixture.hits.map(hit => hit.url), ["/selected"]);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill("SIGKILL"); await run.closed; }
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
    await fixture.close(); await announcements.close();
  }
});

for (const command of ["pandoc", "pdftotext"]) test("wiki:16 real " + command + " receives only fixed arguments and the one captured response buffer", { timeout: 15000 }, async () => {
  const { root, directory } = fresh(), saved = path.join(directory, "stdin.bytes");
  const found = spawnSync("which", [command], { encoding: "utf8" }); assert.equal(found.status, 0);
  const expectedArgs = command === "pandoc" ? ["-f", "html-smart", "-t", "json", "--sandbox"] : ["-enc", "UTF-8", "-eol", "unix", "-nopgbrk", "-", "-"];
  const bin = tool(directory, command, `
const fs = require("node:fs"), cp = require("node:child_process");
const args = process.argv.slice(2);
if(args.includes("--version") || args.includes("-v")) {
  const result = cp.spawnSync(${JSON.stringify(found.stdout.trim())}, args);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
} else {
  require("node:assert/strict").deepEqual(args, ${JSON.stringify(expectedArgs)});
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const bytes = Buffer.concat(chunks); fs.writeFileSync(${JSON.stringify(saved)}, bytes);
    const result = cp.spawnSync(${JSON.stringify(found.stdout.trim())}, args, { input: bytes });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
  });
}
`);
  const bytes = command === "pandoc" ? Buffer.from("<p>Original captured text.</p>") : buildPdf("BT /F1 24 Tf 72 720 Td (Original captured text.) Tj ET");
  const expected = command === "pandoc" ? "Original captured text." : "Original captured text.\n\n";
  const fixture = await serve((_req, res) => { res.writeHead(200, { "content-type": command === "pandoc" ? "text/html" : "application/pdf" }); res.end(bytes); });
  try {
    const result = await cli(root, args(fixture.origin + "/selected"), { PATH: bin }); assert.equal(result.status, 0, JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(saved), bytes); assert.deepEqual(fs.readFileSync(path.join(root, result.data.original)), bytes);
    assert.equal(fs.readFileSync(path.join(root, result.data.extracted), "utf8"), expected);
    assert.equal(result.data.original_sha256, digest(bytes)); assert.equal(result.data.extracted_sha256, digest(expected));
    assert.deepEqual(fixture.hits.map(hit => hit.url), ["/selected"]);
  } finally { await fixture.close(); }
});

test("wiki:16 missing source registration refuses before any network request without repairing registry", { timeout: 15000 }, async () => {
  const { root } = fresh(); fs.unlinkSync(path.join(root, ".wiki/types/source.json"));
  const fixture = await serve((_req, res) => { res.end("must not fetch"); });
  try { await refused(root, fixture.origin + "/forbidden", 2, /registered source type/); assert.equal(fixture.hits.length, 0); }
  finally { await fixture.close(); }
});
