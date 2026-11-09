// Coordinate real filesystem events only; production locks, hashes and publication stay intact.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
const mode = process.env.WIKI_CONCURRENCY_GUARD;
const root = fs.realpathSync(process.argv[process.argv.indexOf("--vault") + 1]);
const candidate = process.argv[process.argv.indexOf("--file") + 1];
const target = path.join(root, "personal/notes/topic.md");
const open = fs.openSync, read = fs.readFileSync, write = fs.writeFileSync;
let candidateFd, paused = false;
function pause(event) {
  fs.writeSync(3, JSON.stringify(event) + "\n");
  const signal = Buffer.alloc(1);
  if (fs.readSync(0, signal, 0, 1, null) !== 1 || signal[0] !== 1) throw new Error("Missing fixture release signal");
}
fs.openSync = (file, ...args) => {
  const fd = open(file, ...args);
  if (file === candidate) candidateFd = fd;
  return fd;
};
fs.readFileSync = (file, ...args) => {
  const bytes = read(file, ...args);
  if (mode === "candidate" && file === candidateFd && !paused) {
    paused = true;
    pause({ event: "candidate-read", pid: process.pid, baseDigest: "sha256:" + createHash("sha256").update(read(target)).digest("hex") });
  }
  return bytes;
};
fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if (mode === "prepared" && String(file).startsWith(path.join(root, ".wiki/tmp/")) && !paused) {
    paused = true;
    pause({ event: "temporary-written", pid: process.pid, temporary: path.relative(root, String(file)) });
  }
  return result;
};
syncBuiltinESMExports();
