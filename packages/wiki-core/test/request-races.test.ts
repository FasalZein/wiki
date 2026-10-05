import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createNote, importTextFile, initVault, readNote, recordCheck, WikiError, type RecordCheckInput } from "../src/index.ts";

const coreUrl = new URL("../src/index.ts", import.meta.url).href;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-request-race-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function fixture() {
  const vault = initVault(path.join(temp, `vault-${++counter}`));
  const file = path.join(temp, `source-${counter}.txt`);
  fs.writeFileSync(file, "Retained source.\n");
  const source = importTextFile(vault, file).observation;
  const first = createNote(vault, { id: "first", authority: "derived", title: "First", body: "First claim.\n" });
  const second = createNote(vault, { id: "second", authority: "derived", title: "Second", body: "Second claim.\n" });
  const input: RecordCheckInput = { requestId: "shared-request", noteId: first.id, noteDigest: first.digest, sourceIds: [source.id], outcome: "supports", checker: "alice", method: "human" };
  return { vault, first, second, input };
}

interface WriterResult {
  ok: boolean;
  code?: string;
  result?: { replayed: boolean; check: unknown };
}

/** Two actual Node writers pause at their first check-record exclusive-link attempt. */
async function concurrentWriters(vaultRoot: string, inputs: RecordCheckInput[]): Promise<WriterResult[]> {
  const arrivals: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    arrivals.push(response);
    if (arrivals.length === inputs.length) for (const arrived of arrivals) arrived.end("release");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const barrierUrl = `http://127.0.0.1:${address.port}/exclusive-link`;
  const children: { child: ChildProcess; closed: Promise<WriterResult> }[] = [];
  try {
    for (const input of inputs) {
      const script = `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const realLink = fs.linkSync;
let gateUsed = false;
fs.linkSync = (source, target) => {
  if (!gateUsed && (target.includes('/evidence/') || target.includes('/check-requests/'))) {
    gateUsed = true;
    execFileSync(process.execPath, ['-e', ${JSON.stringify(`require('node:http').get(${JSON.stringify(barrierUrl)}, response => { response.resume(); response.on('end', () => process.exit(0)); }).on('error', () => process.exit(1));`)}]);
  }
  return realLink(source, target);
};
syncBuiltinESMExports();
import(${JSON.stringify(coreUrl)}).then(core => {
  try { console.log(JSON.stringify({ ok: true, result: core.recordCheck(core.openVault(${JSON.stringify(vaultRoot)}), ${JSON.stringify(input)}) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
});`;
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      const closed = new Promise<WriterResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
          try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
      });
      children.push({ child, closed });
    }
    const results = await Promise.all(children.map(({ closed }) => closed));
    assert.equal(arrivals.length, inputs.length, "both writers reached the real storage boundary before release");
    return results;
  } finally {
    for (const response of arrivals) response.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed.catch(() => undefined);
    }
    assert.equal(server.listening, false);
  }
}

test("review R2: concurrent same request on different notes has one vault-wide effect", async () => {
  const { vault, second, input } = fixture();
  const results = await concurrentWriters(vault.root, [input, { ...input, noteId: second.id, noteDigest: second.digest }]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.code === "conflict").length, 1);
  assert.deepEqual([readNote(vault, "first").status, readNote(vault, "second").status].sort(), ["attested", "unchecked"]);
});

test("review R2: identical concurrent request completes once and reconciles replay", async () => {
  const { vault, input } = fixture();
  const results = await concurrentWriters(vault.root, [input, input]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.deepEqual(results.map((r) => r.result!.replayed).sort(), [false, true]);
  const [first, second] = results;
  assert.ok(first?.result && second?.result);
  assert.deepEqual(first.result.check, second.result.check);
  assert.equal(fs.readdirSync(path.join(vault.root, ".wiki/evidence/first")).length, 1);
  assert.equal(readNote(vault, "first").status, "attested");
});

test("review R2: concurrent changed outcome on one note has only one effect", async () => {
  const { vault, input } = fixture();
  const results = await concurrentWriters(vault.root, [input, { ...input, outcome: "contradicts" }]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.code === "conflict").length, 1);
  assert.equal(fs.readdirSync(path.join(vault.root, ".wiki/evidence/first")).length, 1);
  assert.ok(["attested", "contradicted"].includes(readNote(vault, "first").status));
});

test("review R2: crash after a global claim is incomplete evidence and identical retry finishes it", async () => {
  const { vault, input } = fixture();
  const script = `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const realLink = fs.linkSync;
fs.linkSync = (source, target) => {
  const result = realLink(source, target);
  if (target.includes('/check-requests/')) {
    fs.writeSync(1, 'claimed\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
syncBuiltinESMExports();
import(${JSON.stringify(coreUrl)}).then(core => core.recordCheck(core.openVault(${JSON.stringify(vault.root)}), ${JSON.stringify(input)}));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.resume();
  const lines = createInterface({ input: child.stdout! });
  const closed = once(child, "close");
  try {
    const [event] = await once(lines, "line");
    assert.equal(event, "claimed");
    assert.equal(fs.existsSync(path.join(vault.root, ".wiki/evidence/first/shared-request.json")), false);
    const read = readNote(vault, "first");
    assert.equal(read.status, "invalid");
    assert.match(read.reasons.join("\n"), /incomplete/);
  } finally {
    child.kill("SIGKILL");
    await closed;
    lines.close();
  }
  const completed = recordCheck(vault, input);
  assert.equal(completed.replayed, false, "a claim alone must not report an already completed effect");
  assert.equal(readNote(vault, "first").status, "attested");
  assert.equal(recordCheck(vault, input).replayed, true);
});

test("review R2: damaged global identity never revives positive evidence or permits replay", () => {
  const { vault, input } = fixture();
  recordCheck(vault, input);
  const file = path.join(vault.root, ".wiki/evidence/first/shared-request.json");
  const effect = fs.readFileSync(file);
  fs.writeFileSync(path.join(vault.root, ".wiki/check-requests/shared-request.json"), '{"schema":1,');
  assert.equal(readNote(vault, "first").status, "invalid");
  assert.throws(() => recordCheck(vault, input), (error: unknown) => error instanceof WikiError && error.code === "damaged");
  assert.deepEqual(fs.readFileSync(file), effect);
});
