// Only nondeterministic boundaries are injected. QMD indexing/results remain real.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { registerHooks, syncBuiltinESMExports } from "node:module";
const mode = process.env.OKF_QMD_CLI_GUARD;
if (mode === "close-failure") { process.env.OKF_QMD_FAIL_CLOSE = "yes"; await import("./qmd-cleanup-guard.js"); }
let modelAttempts = 0;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "node-llama-cpp") { modelAttempts++; throw new Error("Model-free CLI attempted native inference import"); }
  if ((mode === "missing-sdk" || mode === "missing-native") && specifier === (mode === "missing-sdk" ? "@tobilu/qmd" : "better-sqlite3")) throw Object.assign(new Error("Injected unavailable SDK"), { code: "ERR_MODULE_NOT_FOUND" });
  return nextResolve(specifier, context);
} });
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error("Model-free CLI attempted network access"); };
process.on("exit", () => {
  if (modelAttempts || networkAttempts) throw new Error("Forbidden model/network attempts: " + modelAttempts + "/" + networkAttempts);
});
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = deny;
net.Socket.prototype.connect = deny; globalThis.fetch = deny;
const read = fs.readFileSync, write = fs.writeFileSync;
let fired = false;
fs.readFileSync = (file, ...args) => {
  if (mode === "unreadable" && String(file).endsWith("/personal/notes/unreadable.md")) throw Object.assign(new Error("Injected unreadable concept"), { code: "EACCES" });
  const bytes = read(file, ...args);
  if (mode === "replace-after-read" && !fired && String(file).endsWith("/personal/notes/observatory.md")) {
    fired = true; write(file, "Unvalidated replacement without frontmatter\n");
  }
  return bytes;
};
fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if (mode === "interrupt-staging" && !fired && String(file).includes("/.wiki/search/snapshots/")) {
    fired = true;
    if (!process.emit("SIGTERM")) throw new Error("CLI has no cooperative SIGTERM listener");
  }
  return result;
};
syncBuiltinESMExports();
