#!/usr/bin/env node
// Boot check for the source CLI (B20, #34). Run from the repository root:
//   heavy -- bun run boot:wiki
// It starts packages/wiki/bin/wiki.js under the current Node, never the root bundle
// or an installed `wiki`. Every step runs in one disposable temporary directory
// with a decoy HOME, asserts its result, and the directory is removed on exit.
// Any failed step exits nonzero. It loads no search engine or model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
const STEP_TIMEOUT_MS = 60_000;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-boot-"));
const vault = path.join(temp, "vault");
const home = path.join(temp, "decoy-home");
const env = { ...process.env, HOME: home, WIKI_VAULT: "" };
for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) delete env[key];
const digest = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

function step(name, args, expectedStatus, check) {
  const result = spawnSync(process.execPath, [BIN, "--vault", vault, "--json", ...args], { cwd: temp, env, encoding: "utf8", timeout: STEP_TIMEOUT_MS });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, name + " was killed by " + result.signal);
  assert.equal(result.status, expectedStatus, name + " exit " + result.status + "\n" + result.stdout + result.stderr);
  const data = JSON.parse(result.stdout);
  check?.(data);
  console.log("boot step " + JSON.stringify({ step: name, exit: result.status }));
  return data;
}

let failed = false;
try {
  console.log("boot start " + JSON.stringify({ node: process.version, bin: BIN, temp }));
  step("init", ["init"], 0, (d) => assert.equal(d.ok, true));
  step("type list", ["type", "list"], 0, (d) => assert.equal(d.ok, true));
  step("lint", ["lint"], 0, (d) => assert.equal(d.ok, true));
  const created = step("new", ["new", "note", "--personal", "--title", "Boot check", "--description", "A disposable boot topic"], 0, (d) => assert.equal(d.ok, true));
  const shown = step("show", ["show", created.path], 0, (d) => {
    assert.equal(d.path, created.path);
    assert.equal(d.digest, digest(fs.readFileSync(path.join(vault, created.path))));
    assert.equal(d.digest, created.digest);
  });
  const candidate = path.join(temp, "candidate.md");
  fs.writeFileSync(candidate, shown.markdown + "\nAn edit that must not land.\n");
  const stale = "sha256:" + "0".repeat(64);
  step("update stale digest refused", ["update", created.path, "--expect", stale, "--file", candidate], 3, (d) => {
    assert.equal(d.ok, false);
    assert.equal(d.error.code, "conflict");
  });
  assert.equal(digest(fs.readFileSync(path.join(vault, created.path))), shown.digest, "Refused update changed the topic");
  step("index check", ["index", "--check"], 0, (d) => assert.equal(d.ok, true));
  assert.equal(fs.existsSync(home), false, "The CLI wrote under the decoy HOME");
} catch (error) {
  failed = true;
  console.error("boot failed: " + (error instanceof Error ? error.message : String(error)));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  const cleaned = !fs.existsSync(temp);
  console.log("boot cleanup " + JSON.stringify({ temp, removed: cleaned }));
  if (!cleaned) failed = true;
}
console.log(failed ? "boot: FAILED" : "boot: OK");
// exitCode, not exit(): stdout to a pipe is asynchronous on macOS and must drain.
process.exitCode = failed ? 1 : 0;
