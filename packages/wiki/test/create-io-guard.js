// Deterministic filesystem events at the real CLI publication boundary, never sleeps.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
const link = fs.linkSync;
const write = fs.writeFileSync;
const mode = process.env.WIKI_CREATE_GUARD;
let published = false;
fs.linkSync = (source, target) => {
  if (String(target).endsWith("/notes/topic.md")) {
    const root = path.resolve(path.dirname(target), "../..");
    const lock = path.join(root, ".wiki/locks/mutation.lock");
    const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.hostname, "string");
    assert.match(owner.token, /^[0-9a-f-]+$/);
    assert.ok(Number.isFinite(Date.parse(owner.started)));
    if (mode === "exclusive") write(target, "External writer bytes\n", { flag: "wx" });
    if (mode === "token") write(lock, JSON.stringify({ ...owner, token: "replacement-token" }));
    if (mode === "replacement") {
      write(lock + ".next", JSON.stringify({ token: "replacement-instance" }));
      fs.renameSync(lock + ".next", lock);
    }
    const result = link(source, target);
    published = true;
    return result;
  }
  return link(source, target);
};
fs.writeFileSync = (target, ...args) => {
  if (mode === "partial" && published && String(target).endsWith("/index.md")) throw new Error("Injected post-note index failure");
  return write(target, ...args);
};
syncBuiltinESMExports();
