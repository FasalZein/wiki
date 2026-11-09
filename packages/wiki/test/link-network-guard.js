// Observe forbidden I/O at the process boundary without touching any real vault or network.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const deny = () => { throw new Error("Lint attempted network access"); };
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = deny;
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
const fixture = fs.realpathSync(process.env.WIKI_TEST_ROOT);
const vault = path.join(fixture, path.relative(process.env.WIKI_TEST_ROOT, process.env.WIKI_TEST_VAULT));
function checked(file) {
  if (typeof file === "number") return;
  const input = file instanceof URL ? fileURLToPath(file) : String(file);
  let resolved;
  try { resolved = fs.realpathSync(input); }
  catch { resolved = path.resolve(input); }
  if (resolved.startsWith(fixture + path.sep) && resolved !== vault && !resolved.startsWith(vault + path.sep)) {
    throw new Error("CLI attempted content I/O outside its selected disposable vault: " + input);
  }
}
for (const name of ["readFileSync", "writeFileSync", "openSync"]) {
  const original = fs[name];
  fs[name] = function(file, ...args) { checked(file); return original.call(this, file, ...args); };
}
syncBuiltinESMExports();
