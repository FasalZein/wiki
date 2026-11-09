// Change real permissions at observed filesystem events; do not synthesize I/O errors.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const link = fs.linkSync;
const write = fs.writeFileSync;
const vault = fs.realpathSync(process.env.WIKI_GUARD_VAULT);
function denyRelease() { fs.chmodSync(path.join(vault, ".wiki/locks"), 0o500); }
const mode = process.env.WIKI_CLEANUP_MODE;
fs.linkSync = (source, target) => {
  const result = link(source, target);
  if ((mode === "temporary" || mode === "both") && (String(target).endsWith("/notes/topic.md") || String(target).endsWith("/types/glossary.json"))) fs.chmodSync(path.dirname(source), 0o500);
  if (mode === "both") denyRelease();
  if (mode === "post-publication") {
    denyRelease();
    if (String(target).endsWith("/notes/topic.md")) fs.chmodSync(path.dirname(target), 0o500);
    else fs.chmodSync(path.join(vault, "log.md"), 0o400);
  }
  return result;
};
fs.writeFileSync = (file, ...rest) => {
  const result = write(file, ...rest);
  if (mode === "release-log" && String(file).endsWith("/log.md") || mode === "release-index" && file === path.join(vault, "index.md") || mode === "release-record" && typeof file === "number") denyRelease();
  if (mode === "partial-index" && file === path.join(vault, "index.md")) {
    denyRelease();
    fs.chmodSync(path.join(vault, "personal/index.md"), 0o400);
  }
  return result;
};
syncBuiltinESMExports();
