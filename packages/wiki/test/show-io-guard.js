// Observe the real CLI's filesystem calls; never substitute note bytes or parser results.
import "./link-network-guard.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks, syncBuiltinESMExports } from "node:module";

const vault = fs.realpathSync(process.env.WIKI_TEST_VAULT);
const note = path.join(vault, process.env.WIKI_TEST_NOTE);
const config = path.join(vault, ".wiki/config.json");
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url.startsWith("file:")) {
    const file = fileURLToPath(resolved.url);
    if (file.startsWith(repoRoot) && !file.startsWith(packageRoot)) throw new Error("Unexpected legacy/global import: " + specifier);
  }
  return resolved;
} });
let reads = 0;
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const full = path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
  if (full === note) {
    reads++;
    if (reads > 1) throw new Error("Requested note read more than once");
  } else if (full.startsWith(vault + path.sep) && full !== config) {
    throw new Error("Unexpected vault content read: " + full);
  }
  return read.call(this, file, ...args);
};
fs.readdirSync = () => { throw new Error("Show attempted a directory inventory"); };
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "linkSync", "symlinkSync", "truncateSync"]) {
  fs[name] = () => { throw new Error("Show attempted a write: " + name); };
}
const open = fs.openSync;
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
fs.openSync = function(file, flags, ...args) {
  if (flags !== "r" && !(typeof flags === "number" && (flags & WRITE_FLAGS) === 0)) throw new Error("Show attempted a writable open");
  // The protected note read opens a descriptor and reads it; count the open of the note itself.
  // Any other vault file opened through a descriptor is an unexpected read, the same rule as readFileSync.
  const full = typeof file === "number" ? undefined : path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
  if (full === note) {
    reads++;
    if (reads > 1) throw new Error("Requested note read more than once");
  } else if (full !== undefined && full.startsWith(vault + path.sep) && full !== config) {
    throw new Error("Unexpected vault content read: " + full);
  }
  return open.call(this, file, flags, ...args);
};
syncBuiltinESMExports();
process.on("exit", () => {
  if (reads !== 1) throw new Error("Expected exactly one actual note read; got " + reads);
});
