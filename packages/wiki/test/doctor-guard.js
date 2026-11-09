// External nondeterminism only. The CLI, inventory, registry and qmd database are real.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { registerHooks, syncBuiltinESMExports } from "node:module";
const mode = process.env.WIKI_DOCTOR_GUARD;
if (mode === "close-failure") { process.env.WIKI_QMD_FAIL_CLOSE = "yes"; await import("./qmd-cleanup-guard.js"); }
// Simulated runtime version only; the process still runs on the real supported Node.
if (mode?.startsWith("node-version:")) Object.defineProperty(process.versions, "node", { value: mode.slice("node-version:".length) });
const root = path.resolve(process.argv[process.argv.indexOf("--vault") + 1]);
const home = process.env.HOME;
const protectedRoots = [root, home, process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME].filter(Boolean);
let forbiddenAttempts = 0;
const forbidden = action => { forbiddenAttempts++; throw new Error("Doctor attempted forbidden " + action); };
process.on("exit", () => { if (forbiddenAttempts) throw new Error("Forbidden doctor attempts: " + forbiddenAttempts); });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "node-llama-cpp") forbidden("model resolution/inference");
  if (specifier === (mode === "missing-sdk" ? "@tobilu/qmd" : mode === "missing-native" ? "better-sqlite3" : mode === "missing-vector" ? "sqlite-vec" : "")) throw new Error("Injected missing " + specifier);
  return next(specifier, context);
} });
const denyNetwork = () => forbidden("network access");
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = denyNetwork;
net.Socket.prototype.connect = denyNetwork; globalThis.fetch = denyNetwork;
const originalRead = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (mode === "unreadable" && String(file).endsWith("/personal/notes/telescope.md")) throw Object.assign(new Error("Injected unreadable concept"), { code: "EACCES" });
  if (mode === "unreadable-index" && String(file).endsWith("/personal/index.md")) throw Object.assign(new Error("EACCES: unreadable generated index fixture"), { code: "EACCES" });
  return originalRead(file, ...args);
};
function check(file) {
  if (typeof file !== "string") return;
  if (protectedRoots.some(base => { const relative = path.relative(base, path.resolve(file)); return relative === "" || !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); })) forbidden("write in protected vault/HOME/XDG: " + file);
}
for (const method of ["writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "unlinkSync", "truncateSync", "chmodSync", "utimesSync"]) {
  const original = fs[method]; fs[method] = (file, ...args) => { check(file); return original(file, ...args); };
}
for (const method of ["renameSync", "linkSync", "copyFileSync", "symlinkSync"]) {
  const original = fs[method]; fs[method] = (from, to, ...args) => { check(from); check(to); return original(from, to, ...args); };
}
const open = fs.openSync;
fs.openSync = (file, flags, ...args) => { if (flags !== "r" && flags !== fs.constants.O_RDONLY) check(file); return open(file, flags, ...args); };
syncBuiltinESMExports();
