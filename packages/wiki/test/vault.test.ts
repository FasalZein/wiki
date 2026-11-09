import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, spawnCli } from "./cli-helper.ts";
import { openVault, profileProblem, readNoteRevision, readRevisionAt, VAULT_LAYOUT, WikiError } from "../src/vault.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-vault-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const TOPIC = "personal/notes/topic.md";
const NOTE = "---\ntype: note\ntitle: Topic\ndescription: A topic\ncreated: 2026-11-09T12:00:00Z\n---\n# Topic\n";
let counter = 0;
async function fresh(): Promise<string> {
  const vault = path.join(temp, String(++counter));
  const init = await runCli(["init", vault, "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.mkdirSync(path.join(vault, "personal/notes"), { recursive: true });
  fs.writeFileSync(path.join(vault, TOPIC), NOTE);
  return fs.realpathSync(vault);
}
function tree(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map(name => name + " " + (fs.statSync(path.join(root, name)).isFile() ? fs.readFileSync(path.join(root, name), "utf8") : "dir"));
}

test("one layout definition matches the README init contract", () => {
  // README, Initialization: config, seven types under .wiki/types/, .wiki/tmp/ and .wiki/locks/, root index.md, log.md, .gitignore.
  assert.deepEqual(VAULT_LAYOUT.map(item => item.path + ":" + item.kind), [":directory", ".wiki:directory", ".wiki/config.json:file", ".wiki/types:directory", ".wiki/tmp:directory", ".wiki/locks:directory", "index.md:file", "log.md:file", ".gitignore:file"]);
  // Every operational entry a command uses, including the lock directory, is required at open.
  assert.deepEqual(VAULT_LAYOUT.filter(item => !item.open).map(item => item.path), ["index.md", ".gitignore"]);
});

test("one profile rule: identity, unsupported, or supported", () => {
  for (const config of [null, [], "wiki-okf", {}, { profile: "wiki-okf" }, { version: 1 }]) assert.equal(profileProblem(config), "identity", JSON.stringify(config));
  for (const config of [{ profile: "wiki-okf", version: 2 }, { profile: "other", version: 1 }, { profile: "wiki-okf", version: "1" }]) assert.equal(profileProblem(config), "unsupported", JSON.stringify(config));
  assert.equal(profileProblem({ profile: "wiki-okf", version: 1, search: {} }), undefined);
});

test("openVault returns a handle on the canonical root whose note read returns bytes, digest and mode", async () => {
  const vault = await fresh();
  fs.chmodSync(path.join(vault, TOPIC), 0o640);
  const handle = openVault(path.join(vault, "personal", ".."));
  assert.equal(handle.root, vault);
  assert.equal(handle.entry(TOPIC).full, path.join(vault, TOPIC));
  const revision = handle.readNoteRevision(TOPIC, "note");
  assert.equal(revision.bytes.toString("utf8"), NOTE);
  assert.equal(revision.digest, "sha256:" + createHash("sha256").update(NOTE).digest("hex"));
  assert.equal(revision.mode, 0o640);
  assert.throws(() => handle.readNoteRevision("personal/notes/none.md", "note"), (error: unknown) => error instanceof WikiError && error.code === "not_found" && error.message === "Missing requested note: personal/notes/none.md");
});

test("the protected note read refuses a FIFO without waiting for a writer, and a symlink without following it", async () => {
  const vault = await fresh();
  const fifo = path.join(vault, "personal/notes/fifo.md");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const notRegular = () => new Error("not regular");
  // An unopened FIFO would block a plain read forever; the nonblocking open plus descriptor check returns at once.
  assert.throws(() => readRevisionAt(fifo, notRegular), /not regular/);
  assert.throws(() => readNoteRevision(vault, "personal/notes/fifo.md", "topic"), (error: unknown) => error instanceof WikiError && error.code === "usage" && error.message === "Expected a regular Markdown topic: personal/notes/fifo.md");
  const link = path.join(vault, "personal/notes/link.md");
  fs.symlinkSync(path.join(vault, TOPIC), link);
  // A symlink swapped in after the caller's lstat is refused by O_NOFOLLOW, with the caller's not-regular error.
  assert.throws(() => readRevisionAt(link, notRegular), /not regular/);
  assert.throws(() => readNoteRevision(vault, "personal/notes/link.md", "note"), (error: unknown) => error instanceof WikiError && error.code === "usage" && /symlink/.test(error.message));
});

test("show refuses a FIFO note with the regular-file usage error and changes nothing", async () => {
  const vault = await fresh();
  assert.equal(spawnSync("mkfifo", [path.join(vault, "personal/notes/fifo.md")]).status, 0);
  const before = tree(vault);
  const result = await runCli(["--vault", vault, "show", "personal/notes/fifo.md", "--json"]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: "usage", message: "Expected a regular Markdown note: personal/notes/fifo.md" } });
  assert.deepEqual(tree(vault), before);
});

test("show refuses a note swapped for a symlink after its check with the regular-file usage error, exit 2", async () => {
  const vault = await fresh();
  const result = spawnCli(["--vault", vault, "show", TOPIC, "--json"], {
    imports: [fileURLToPath(new URL("./symlink-swap-guard.js", import.meta.url))], cwd: temp,
    env: { HOME: temp, WIKI_TEST_VAULT: vault, WIKI_TEST_NOTE: TOPIC },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: "usage", message: "Expected a regular Markdown note: " + TOPIC } });
  assert.ok(fs.lstatSync(path.join(vault, TOPIC)).isSymbolicLink(), "the guard swapped the note");
});

test("a vault without .wiki/locks fails at open with the layout diagnostic for reads and writes alike", async () => {
  const vault = await fresh();
  fs.rmdirSync(path.join(vault, ".wiki/locks"));
  const before = tree(vault);
  // Before the shared layout, show and lint opened this vault and only lock-taking commands failed.
  for (const args of [["show", TOPIC], ["lint"], ["index", "--check"], ["type", "list"], ["new", "note", "--personal", "--title", "T", "--description", "D"]]) {
    const result = await runCli(["--vault", vault, ...args, "--json"]);
    assert.equal(result.status, 6, args.join(" ") + ": " + result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: "damaged", message: "Missing vault entry: .wiki/locks" } }, args.join(" "));
  }
  const human = await runCli(["--vault", vault, "show", TOPIC]);
  assert.equal(human.status, 6);
  assert.equal(human.stdout, "");
  assert.equal(human.stderr, "damaged: Missing vault entry: .wiki/locks\n");
  // Init and doctor read the same layout definition.
  const init = await runCli(["init", vault, "--json"]);
  assert.equal(init.status, 6);
  assert.match(JSON.parse(init.stdout).error.message, /\.wiki\/locks \(missing or not a directory\)/);
  const doctor = await runCli(["--vault", vault, "doctor", "--json"]);
  assert.ok(JSON.parse(doctor.stdout).diagnostics.some((d: { path: string }) => d.path === ".wiki/locks"), doctor.stdout);
  assert.deepEqual(tree(vault), before);
});
