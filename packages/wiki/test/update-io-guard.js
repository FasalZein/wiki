// Only filesystem events are injected. Validation and publication run in the real CLI.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const mode = process.env.WIKI_UPDATE_GUARD;
const root = fs.realpathSync(process.argv[process.argv.indexOf("--vault") + 1]);
const target = path.join(root, "personal/notes/topic.md");
const write = fs.writeFileSync, open = fs.openSync, rename = fs.renameSync, rm = fs.rmSync, unlink = fs.unlinkSync;
let prepared = false, published = false;
const permissionEvents = [];
if (mode.includes("permissions")) process.umask(0o022);
function observePermissions(event, stat) {
  if (!mode.includes("permissions")) return;
  permissionEvents.push({ event, mode: stat.mode & 0o777, size: stat.size });
  write(process.env.WIKI_UPDATE_MODE_EVENTS, JSON.stringify(permissionEvents));
}
function forbidden(file) {
  if (typeof file !== "string" || !file.startsWith(root + "/")) return false;
  return mode === "read-only" || mode === "no-op" && !file.endsWith("/mutation.lock");
}
fs.openSync = (file, flags, ...args) => {
  if (mode === "candidate-fifo" && file === process.argv[process.argv.indexOf("--file") + 1]) {
    unlink(file);
    assert.equal(spawnSync("mkfifo", [file]).status, 0);
  }
  if (flags !== "r" && typeof flags === "string" && forbidden(String(file))) throw new Error("Unexpected vault write open: " + file);
  const fd = open(file, flags, ...args);
  if (String(file).startsWith(path.join(root, ".wiki/tmp/")) && flags === "wx") observePermissions("created", fs.fstatSync(fd));
  return fd;
};
fs.writeFileSync = (file, ...args) => {
  if (forbidden(file)) throw new Error("Unexpected vault write: " + file);
  if (published && (mode.startsWith("index") && String(file).endsWith("/index.md") || mode === "log-fail" && String(file).endsWith("/log.md"))) throw new Error("Injected post-publication failure");
  const result = write(file, ...args);
  if (!prepared && String(file).startsWith(path.join(root, ".wiki/tmp/"))) {
    prepared = true;
    observePermissions("written", fs.statSync(file));
    const lock = JSON.parse(fs.readFileSync(path.join(root, ".wiki/locks/mutation.lock"), "utf8"));
    assert.equal(lock.pid, process.pid);
    if (mode.startsWith("stale")) write(target, "External writer bytes\n");
    if (mode === "missing-final") unlink(target);
    if (mode === "unsafe-final") { unlink(target); fs.symlinkSync(process.argv[process.argv.indexOf("--file") + 1], target); }
  }
  return result;
};
fs.renameSync = (from, to) => {
  const result = rename(from, to);
  if (to === target) { assert.equal(prepared, true); published = true; }
  return result;
};
fs.rmSync = (file, ...args) => {
  if (mode.startsWith("stale-cleanup") && String(file).includes("/.wiki/tmp/")) throw new Error("Injected temp cleanup failure");
  if (forbidden(file)) throw new Error("Unexpected vault removal: " + file);
  return rm(file, ...args);
};
fs.unlinkSync = file => {
  if (mode.includes("release") && String(file).endsWith("/mutation.lock")) throw new Error("Injected lock release failure");
  if (forbidden(file)) throw new Error("Unexpected vault unlink: " + file);
  return unlink(file);
};
syncBuiltinESMExports();
