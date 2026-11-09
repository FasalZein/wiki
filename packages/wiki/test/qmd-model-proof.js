// Opt-in macOS proof. Run through heavy with existing local GGUFs only:
// OKF_QMD_MODEL_DIR=/existing/models heavy -- node packages/okf-wiki/test/qmd-model-proof.js
// The parent checks external state even if the isolated child fails or receives a signal.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "This proof requires macOS sandbox-exec; do not run without OS isolation");
assert.ok(process.env.OKF_QMD_MODEL_DIR, "Supply existing local GGUFs; this proof never downloads models");
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const modelDir = fs.realpathSync(process.env.OKF_QMD_MODEL_DIR);
const roots = [...new Set([
  modelDir,
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "qmd"),
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "qmd"),
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "qmd"),
])];
function fileDigest(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
function snapshot() {
  const rows = [];
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      rows.push({ path: file, missing: true });
      return;
    }
    const row = { path: file, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.isSymbolicLink()) row.link = fs.readlinkSync(file);
    else if (stat.isFile()) row.sha256 = fileDigest(file);
    rows.push(row);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  for (const root of roots) visit(root);
  return rows;
}
const before = snapshot();
const sandbox = fs.mkdtempSync(path.join(packageRoot, "node_modules/.qmd-model-proof-"));
const profile = path.join(sandbox, "proof.sb");
fs.writeFileSync(profile, [
  "(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)",
  '(allow file-write* (subpath ' + JSON.stringify(sandbox) + ') (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
].join("\n"));
let child;
let interrupted;
function stop(signal) {
  interrupted = signal;
  // The child has its own process group. Never signal unrelated workers.
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
const onTerm = () => stop("SIGTERM");
const onInt = () => stop("SIGINT");
try {
  child = spawn("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, fileURLToPath(new URL(process.env.OKF_QMD_PROOF === "find" ? "qmd-find-smoke-child.js" : "qmd-model-proof-child.js", import.meta.url))], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, OKF_QMD_MODEL_DIR: modelDir, OKF_QMD_SANDBOX: sandbox },
  });
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  console.error("child shutdown", JSON.stringify({ node: process.version, ...result, interrupted }));
  assert.equal(result.code, 0, "Native proof did not exit successfully");
  assert.equal(interrupted, undefined, "Native proof was interrupted");
} finally {
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  let alive = false;
  if (child?.pid) {
    try { process.kill(-child.pid, 0); alive = true; }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    if (alive) stop("cleanup");
  }
  try {
    const after = snapshot();
    console.error("external state proof", JSON.stringify({ before, after, processGroupGone: !alive }));
    assert.deepEqual(after, before, "Existing model/global QMD state changed");
    assert.equal(alive, false, "Child left a live process group");
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}
