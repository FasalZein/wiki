import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/okf-wiki.js", import.meta.url));
const GUARD = fileURLToPath(new URL("./concurrency-io-guard.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "okf-concurrent-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const relative = "personal/notes/topic.md";
let counter = 0;
function digest(bytes: string) { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
function read(vault: string, file = relative) { return fs.readFileSync(path.join(vault, file), "utf8"); }
function env() { return { ...process.env, HOME: temp, WIKI_VAULT: "" }; }
function cli(vault: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [BIN, "--json", "--vault", vault, ...args], {
    cwd: temp, env: env(), encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return { status: result.status, data: JSON.parse(result.stdout) };
}
function succeeds(vault: string, ...args: string[]) {
  const result = cli(vault, ...args); assert.equal(result.status, 0, JSON.stringify(result)); return result.data;
}
function fresh() {
  const vault = path.join(temp, String(++counter)); succeeds(vault, "init");
  const note = succeeds(vault, "new", "note", "--personal", "--title", "Topic", "--description", "Original description");
  return { vault, note, bytes: read(vault) };
}
function candidate(bytes: string) {
  const file = path.join(temp, "candidate-" + ++counter + ".md"); fs.writeFileSync(file, bytes); return file;
}
function args(expected: string, file: string) { return ["update", relative, "--expect", expected, "--file", file]; }
function start(vault: string, expected: string, file: string, mode: string) {
  const child = spawn(process.execPath, ["--import", GUARD, BIN, "--json", "--vault", vault, ...args(expected, file)], {
    cwd: temp, env: { ...env(), OKF_CONCURRENCY_GUARD: mode }, stdio: ["pipe", "pipe", "pipe", "pipe"],
    timeout: 15000, killSignal: "SIGKILL",
  });
  let stdout = "", stderr = "", failure: Error | undefined;
  child.stdout!.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.on("error", error => { failure = error; });
  const stream = child.stdio[3]; assert.ok(stream instanceof Readable);
  const lines = createInterface({ input: stream });
  const event = new Promise<string>(resolve => lines.once("line", resolve));
  const done = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (status, signal) => { lines.close(); resolve({ status, signal }); });
  });
  return {
    child, done,
    async event() {
      const line = await Promise.race([event, done.then(() => { throw new Error("CLI exited before coordination event: " + stdout + stderr); })]);
      return JSON.parse(line);
    },
    release() { child.stdin!.end(Buffer.from([1])); },
    async result() {
      const result = await done;
      assert.equal(failure, undefined); assert.equal(result.signal, null); assert.equal(stderr, "");
      assert.equal(stdout.trim().split("\n").length, 1);
      return { status: result.status, data: JSON.parse(stdout) };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    },
  };
}
function clean(vault: string) {
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
  assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/tmp")), []);
}

test("okf:09 overlapping CLI updates observing one base yield one success and one stale conflict, not busy", async () => {
  const { vault, note, bytes } = fresh();
  const firstBytes = bytes.replace("Original description", "Winning description") + "First candidate\n";
  const first = start(vault, note.digest, candidate(firstBytes), "candidate");
  const second = start(vault, note.digest, candidate(bytes + "Second candidate\n"), "candidate");
  try {
    const events = await Promise.all([first.event(), second.event()]);
    assert.deepEqual(events.map(event => event.event), ["candidate-read", "candidate-read"]);
    assert.deepEqual(events.map(event => event.baseDigest), [note.digest, note.digest]);
    assert.notEqual(events[0].pid, events[1].pid);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
    first.release();
    const winner = await first.result();
    assert.equal(winner.status, 0, JSON.stringify(winner)); assert.equal(winner.data.written, true);
    assert.equal(winner.data.digest, digest(firstBytes));
    // The losing process has already read its candidate and observed the old base.
    // Release it only after the winner's real lock cleanup, not into a held-lock busy result.
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/locks")), []);
    second.release();
    const loser = await second.result();
    assert.equal(loser.status, 3, JSON.stringify(loser)); assert.equal(loser.data.error.code, "conflict");
    assert.match(loser.data.error.message, /Stale base.*re-read.*do not retry/);
    assert.equal(loser.data.path, relative); assert.equal(loser.data.expected, note.digest);
    assert.equal(loser.data.current, digest(firstBytes)); assert.equal(loser.data.written, undefined);
    assert.equal(read(vault), firstBytes);
    assert.equal(read(vault, "log.md").split("**updated**").length - 1, 1);
    assert.match(read(vault, "personal/notes/index.md"), /Winning description/);
    succeeds(vault, "index", "--check"); succeeds(vault, "lint"); clean(vault);
  } finally { await Promise.all([first.stop(), second.stop()]); }
});

test("okf:09 live-owner busy and crash-left locks require inspected explicit recovery, never age stealing", async () => {
  const { vault, note, bytes } = fresh(), file = candidate(bytes + "Recovered update\n");
  const lock = path.join(vault, ".wiki/locks/mutation.lock"), beforeLog = read(vault, "log.md");
  const owner = start(vault, note.digest, file, "prepared");
  try {
    const event = await owner.event(); assert.equal(event.event, "temporary-written");
    const lockBytes = fs.readFileSync(lock), identity = JSON.parse(lockBytes.toString());
    assert.equal(identity.pid, owner.child.pid); assert.equal(event.pid, identity.pid);
    assert.equal(identity.hostname, os.hostname()); assert.match(identity.token, /^[0-9a-f-]+$/);
    assert.ok(Number.isFinite(Date.parse(identity.started)));
    const busy = cli(vault, ...args(note.digest, file));
    assert.equal(busy.status, 3); assert.equal(busy.data.error.code, "conflict");
    assert.match(busy.data.error.message, /lock busy.*inspect its owner.*explicit operator recovery.*never reclaimed automatically/);
    assert.equal(busy.data.written, undefined); assert.deepEqual(fs.readFileSync(lock), lockBytes);
    // The busy command completed while the live owner remained paused at its actual temp write.
    assert.equal(owner.child.exitCode, null); process.kill(identity.pid, 0);
    owner.child.kill("SIGKILL");
    assert.deepEqual(await owner.done, { status: null, signal: "SIGKILL" });
    assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
    assert.deepEqual(fs.readFileSync(lock), lockBytes);
    assert.equal(read(vault), bytes); assert.equal(read(vault, "log.md"), beforeLog);
    assert.equal(read(vault, event.temporary), bytes + "Recovered update\n");
    fs.utimesSync(lock, 0, 0);
    for (const command of [args(note.digest, file), ["index"]]) {
      const blocked = cli(vault, ...command);
      assert.equal(blocked.status, 3); assert.match(blocked.data.error.message, /lock busy.*explicit operator recovery/);
      assert.equal(blocked.data.written, undefined); assert.deepEqual(fs.readFileSync(lock), lockBytes);
      assert.equal(fs.statSync(lock).mtimeMs, 0);
    }
    // Fixture operator checks the actual dead PID, owner record and unpublished scratch before removal.
    assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
    assert.deepEqual(fs.readFileSync(lock), lockBytes);
    fs.unlinkSync(path.join(vault, event.temporary)); fs.unlinkSync(lock);
    succeeds(vault, "index"); assert.equal(read(vault, "log.md"), beforeLog);
    const recovered = succeeds(vault, ...args(note.digest, file));
    assert.equal(recovered.written, true); assert.equal(read(vault), bytes + "Recovered update\n");
    assert.equal(read(vault, "log.md").split("**updated**").length - 1, 1);
    succeeds(vault, "index", "--check"); succeeds(vault, "lint"); clean(vault);
  } finally { await owner.stop(); }
});

for (const mode of ["index-fail", "log-fail"]) test("okf:09 index recovery preserves later edits and does not invent omitted update history: " + mode, () => {
  const { vault, note, bytes } = fresh();
  const published = bytes.replace("Original description", "Published description") + "Published fact\n";
  const log = read(vault, "log.md");
  const result = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./update-io-guard.js", import.meta.url)), BIN, "--json", "--vault", vault, ...args(note.digest, candidate(published))], {
    cwd: temp, env: { ...env(), OKF_UPDATE_GUARD: mode }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.error, undefined); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const partial = JSON.parse(result.stdout);
  assert.equal(result.status, 6); assert.equal(partial.ok, false); assert.equal(partial.written, true);
  assert.deepEqual(partial.paths, [relative]); assert.equal(partial.digest, digest(published));
  assert.match(partial.error.message, /run index to repair navigation.*inspect log.md.*manually/);
  assert.equal(read(vault), published); assert.equal(read(vault, "log.md"), log);
  const later = published.replace("Published description", "Later external description") + "Later external fact\n";
  fs.writeFileSync(path.join(vault, relative), later);
  const staleIndex = cli(vault, "index", "--check"); assert.equal(staleIndex.status, 1);
  succeeds(vault, "index"); succeeds(vault, "index", "--check"); succeeds(vault, "lint");
  assert.equal(read(vault), later); assert.equal(succeeds(vault, "show", relative).digest, digest(later));
  assert.match(read(vault, "personal/notes/index.md"), /Later external description/);
  assert.equal(read(vault, "log.md"), log); assert.equal(log.includes("**updated**"), false);
  clean(vault);
});
