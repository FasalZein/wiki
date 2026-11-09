// Real filesystem changes at observed source-read, lock, and exclusive-publication events.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
const root = fs.realpathSync(process.argv[process.argv.indexOf("--vault") + 1]);
const input = process.argv[process.argv.indexOf("capture") + 1];
const inputStat = fs.statSync(input), mode = process.env.WIKI_CAPTURE_GUARD;
const open = fs.openSync, read = fs.readFileSync, write = fs.writeFileSync, link = fs.linkSync, mkdir = fs.mkdirSync;
const lock = path.join(root, ".wiki/locks/mutation.lock"), tmp = path.join(root, ".wiki/tmp");
let reads = 0;
function denyRelease() { fs.chmodSync(path.dirname(lock), 0o500); }
fs.readFileSync = (file, ...args) => {
  const stat = typeof file === "number" ? fs.fstatSync(file) : undefined;
  if (stat && stat.dev === inputStat.dev && stat.ino === inputStat.ino) {
    assert.equal(fs.existsSync(lock), false, "input extraction must finish outside the mutation lock");
    assert.equal(++reads, 1, "selected input is read once");
  }
  return read(file, ...args);
};
fs.openSync = (file, flags, ...args) => {
  if (file === lock && flags === "wx") {
    assert.equal(reads, 1, "input bytes must be captured before lock acquisition");
    assert.equal(fs.existsSync(path.join(root, "personal/assets")), false, "validation cannot temporarily publish assets");
    const registry = path.join(root, ".wiki/types/source.json");
    if (mode.startsWith("registry-")) {
      const record = JSON.parse(read(registry, "utf8"));
      if (mode.startsWith("registry-folder")) record.folder = "observations";
      if (mode.startsWith("registry-scope")) record.scopes = ["projects/demo"];
      if (mode === "registry-schema") { record.frontmatterSchema.required.push("category"); record.frontmatterSchema.properties.category = { type: "string" }; }
      if (mode === "registry-missing") fs.unlinkSync(registry);
      else write(registry, JSON.stringify(record));
    }
    if (mode === "late-note") { fs.mkdirSync(path.join(root, "personal/references"), { recursive: true }); write(path.join(root, "personal/references/captured-topic.md"), "External note\n", { flag: "wx" }); }
    if (mode === "late-asset") fs.mkdirSync(path.join(root, "personal/assets/captured-topic"), { recursive: true });
    if (mode === "late-duplicate" || mode === "unrelated-damage") {
      fs.mkdirSync(path.join(root, "personal/notes"), { recursive: true });
      write(path.join(root, "personal/notes/existing.md"), mode === "unrelated-damage" ? "---\nbad: [\n---\n" : '---\ntype: note\ntitle: Captured topic\ndescription: Existing\ncreated: "2026-01-01T00:00:00Z"\n---\nExisting\n');
    }
  }
  return open(file, flags, ...args);
};
fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if (typeof file === "number" && fs.fstatSync(file).ino === fs.statSync(lock).ino) {
    if (mode === "extract-before-lock") assert.equal(reads, 1);
    if (mode === "first-asset-fail") fs.chmodSync(tmp, 0o500);
    if (mode === "registry-scope-release") denyRelease();
  }
  if (file === path.join(root, "log.md") && mode === "release") denyRelease();
  return result;
};
fs.linkSync = (from, to) => {
  const original = String(to).endsWith("/original.txt"), extracted = String(to).endsWith("/extracted.txt"), note = String(to).endsWith("/references/captured-topic.md");
  if (original && mode === "link-cleanup" || extracted && mode.startsWith("second-link-cleanup")) {
    write(to, "External asset\n", { flag: "wx" });
    fs.chmodSync(tmp, 0o500);
    if (mode.endsWith("-release")) denyRelease();
  }
  const result = link(from, to);
  if (original && mode === "asset-fail") fs.chmodSync(path.dirname(to), 0o500);
  if (extracted && mode === "note-fail") fs.chmodSync(path.join(root, "personal/references"), 0o500);
  if (note && mode.startsWith("index")) fs.chmodSync(path.join(root, "index.md"), 0o400);
  if (note && mode === "log-fail") fs.chmodSync(path.join(root, "log.md"), 0o400);
  if (original && mode.startsWith("temporary") || note && mode === "note-temporary") fs.chmodSync(tmp, 0o500);
  if (original && mode === "temporary-release" || note && mode === "index-release") denyRelease();
  return result;
};
fs.mkdirSync = (directory, ...args) => {
  if (directory === path.join(root, "personal/assets/captured-topic")) {
    if (mode === "reserve-race") mkdir(directory);
    if (mode === "reserve-permission") fs.chmodSync(path.dirname(directory), 0o500);
  }
  return mkdir(directory, ...args);
};
syncBuiltinESMExports();
