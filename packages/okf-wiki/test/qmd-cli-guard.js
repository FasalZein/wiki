// Only nondeterministic boundaries are injected. QMD indexing/results remain real.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { registerHooks, syncBuiltinESMExports } from "node:module";
const mode = process.env.OKF_QMD_CLI_GUARD;
if (mode === "close-failure") { process.env.OKF_QMD_FAIL_CLOSE = "yes"; await import("./qmd-cleanup-guard.js"); }
let modelAttempts = 0;
// Fake only external inference: the wrapper keeps the real SDK store and SQLite storage.
const FAKE_INFERENCE = new URL("./qmd-fake-inference.js", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (mode?.startsWith("fake-inference") && specifier === "@tobilu/qmd" && context.parentURL !== FAKE_INFERENCE) return { url: FAKE_INFERENCE, shortCircuit: true };
  if (specifier === "node-llama-cpp") { modelAttempts++; throw new Error("Model-free CLI attempted native inference import"); }
  if ((mode === "missing-sdk" || mode === "missing-native") && specifier === (mode === "missing-sdk" ? "@tobilu/qmd" : "better-sqlite3")) throw Object.assign(new Error("Injected unavailable SDK"), { code: "ERR_MODULE_NOT_FOUND" });
  return nextResolve(specifier, context);
} });
let networkAttempts = 0;
// Find and sync must not start detached embedding workers or any subprocess.
if (process.env.OKF_QMD_DENY_SUBPROCESS === "1") {
  const cp = await import("node:child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp.default[name] = () => { throw new Error("Search attempted subprocess " + name); };
}
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
// Two-process stale-index schedule, synchronized only at source events through FIFOs
// (blocking open/read, no polling): B captures R0 and pauses before its index lock;
// A captures R1, syncs and releases; B syncs R0 and releases; then A queries.
const fifo = (name) => path.join(process.env.OKF_QMD_FIFO_DIR ?? "", name);
let staleB = false, staleA = false;
fs.writeFileSync = (file, ...args) => {
  if (mode === "stale-b" && !staleB && String(file).endsWith("/.wiki/search/writer.lock")) {
    staleB = true; write(fifo("b-captured"), "captured R0"); read(fifo("b-go"));
  }
  const result = write(file, ...args);
  if (mode === "inspect-active-lock-ignore" && String(file).endsWith("/.wiki/search/writer.lock")) {
    const root = path.resolve(process.argv[process.argv.indexOf("--vault") + 1]);
    const checked = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", ".wiki/search/writer.lock"], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, GIT_DIR: path.join(root, ".git"), GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(root, ".git/index"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "" },
    });
    if (checked.error) throw checked.error;
    write(path.join(root, ".wiki/tmp/active-lock-ignore.json"), JSON.stringify({ exists: fs.existsSync(file), status: checked.status, stdout: checked.stdout, stderr: checked.stderr }));
  }
  if (mode === "interrupt-staging" && !fired && String(file).includes("/.wiki/search/snapshots/")) {
    fired = true;
    if (!process.emit("SIGTERM")) throw new Error("CLI has no cooperative SIGTERM listener");
  }
  return result;
};
const unlink = fs.unlinkSync;
fs.unlinkSync = (file, ...args) => {
  const result = unlink(file, ...args);
  // Another cooperative writer takes the index lock between text sync and find/embed.
  if (mode === "stale-b" && String(file).endsWith("/.wiki/search/writer.lock")) write(fifo("a-go"), "synced R0");
  if (mode === "fake-inference-stale-a" && !staleA && String(file).endsWith("/.wiki/search/writer.lock")) { staleA = true; write(fifo("b-go"), "synced R1"); read(fifo("a-go")); }
  if (mode === "fake-inference-steal-lock" && !fired && String(file).endsWith("/.wiki/search/writer.lock")) { fired = true; write(file, "other writer", { flag: "wx" }); }
  return result;
};
syncBuiltinESMExports();
