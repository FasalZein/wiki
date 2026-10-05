// Spawns the real CLI under Node against disposable vaults and Git repositories.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/wiki-cli.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-cli-test-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;

interface Run {
  status: number;
  json: Record<string, any>;
  stdout: string;
  stderr: string;
}

function cli(vault: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, [BIN, "--vault", vault, "--json", ...args], { encoding: "utf8", env: { ...process.env, WIKI_VAULT: "" } });
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // Non-JSON output is asserted through stdout/stderr where relevant.
  }
  return { status: r.status ?? -1, json, stdout: r.stdout, stderr: r.stderr };
}

function ok(r: Run): Record<string, any> {
  assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stderr}`);
  assert.equal(r.json.ok, true);
  return r.json;
}

function freshVault(): string {
  const dir = path.join(temp, `vault-${++counter}`);
  ok(cli(dir, "init", dir));
  return dir;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();
}

function freshRepo(files: Record<string, string>): string {
  const repo = path.join(temp, `repo-${++counter}`);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, files, "initial");
  return repo;
}

function commit(repo: string, files: Record<string, string | null>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(repo, rel);
    if (content === null) fs.rmSync(file);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** Vault with a derived note checked against committed code; returns handles for mutation. */
function checkedCodeNote(id = "auth-flow") {
  const vault = freshVault();
  const repo = freshRepo({ "src/auth.ts": "export const login = () => true;\n" });
  ok(cli(vault, "repo", "add", "app", "--path", repo, "--ref", "main"));
  const note = ok(cli(vault, "note", "create", "--id", id, "--authority", "derived", "--title", "Auth flow", "--body", "Login always succeeds.\n"));
  const cap = ok(cli(vault, "capture", "code", "--repo", "app", "--path", "src/auth.ts", "--request-id", `cap-${id}`));
  const obs = cap.observations[0];
  const read = ok(cli(vault, "read", id));
  assert.equal(read.status, "unchecked", "a captured source alone never attests");
  const checkArgs = ["check", id, "--note-digest", read.digest, "--source", obs.id, "--outcome", "supports", "--checker", "alice", "--method", "human", "--request-id", `chk-${id}`];
  const check = ok(cli(vault, ...checkArgs));
  return { vault, repo, id, note, obs, read, check, checkArgs, noteFile: path.join(vault, note.path) };
}

describe("vault and authority classes", () => {
  test("personal note is owner-authored without code links; record is historical", () => {
    const vault = freshVault();
    ok(cli(vault, "note", "create", "--id", "my-idea", "--authority", "personal", "--title", "Idea", "--body", "Maybe cache it.\n"));
    ok(cli(vault, "note", "create", "--id", "meeting-2026-10-01", "--authority", "record", "--title", "Meeting", "--body", "We met.\n"));
    const personal = ok(cli(vault, "read", "my-idea"));
    assert.equal(personal.status, "owner-authored");
    assert.deepEqual(personal.sources, []);
    assert.equal(personal.body, "Maybe cache it.\n");
    const record = ok(cli(vault, "read", "meeting-2026-10-01"));
    assert.equal(record.status, "historical");
  });

  test("note create never overwrites an existing note", () => {
    const vault = freshVault();
    ok(cli(vault, "note", "create", "--id", "a", "--authority", "personal", "--title", "A", "--body", "one"));
    const again = cli(vault, "note", "create", "--id", "a", "--authority", "personal", "--title", "A", "--body", "two");
    assert.equal(again.status, 3);
    assert.match(fs.readFileSync(path.join(vault, "notes/a.md"), "utf8"), /one$/);
  });

  test("hand-authored trust fields are ignored", () => {
    const vault = freshVault();
    fs.writeFileSync(path.join(vault, "notes/claimed.md"), '---\nid: claimed\nauthority: derived\nstatus: attested\ntrust: verified\n---\nTrust me.\n');
    const r = ok(cli(vault, "read", "claimed"));
    assert.equal(r.status, "unchecked");
    assert.ok(r.reasons.some((x: string) => x.includes('"status"')));
  });

  test("unsupported vault schema is refused", () => {
    const vault = freshVault();
    fs.writeFileSync(path.join(vault, ".wiki/vault.json"), JSON.stringify({ schema: 99, repos: {} }));
    const r = cli(vault, "read", "x");
    assert.equal(r.status, 5);
    assert.match(r.json.error.message, /unsupported vault schema/);
  });
});

describe("code-backed checks", () => {
  test("check attests reviewed note against committed code and reports local-only scope", () => {
    const { vault, repo, id, obs, read, check } = checkedCodeNote();
    assert.equal(check.replayed, false);
    assert.notEqual(check.check.id, read.digest, "check identity is distinct from content identity");
    assert.equal(obs.locator.commit, git(repo, "rev-parse", "main"));
    assert.equal(obs.locator.scope, "local-commit");
    const r = ok(cli(vault, "read", id));
    assert.equal(r.status, "attested");
    assert.equal(r.digest, read.digest);
    assert.equal(r.repos.length, 1);
    assert.equal(r.repos[0].commit, git(repo, "rev-parse", "main"));
    assert.equal(r.repos[0].ref, "main");
    assert.ok(r.reasons.some((x: string) => x.includes("asserted, not authenticated")));
    const text = spawnSync(process.execPath, [BIN, "--vault", vault, "read", id], { encoding: "utf8" }).stdout;
    assert.match(text, /status: attested/);
    assert.match(text, /local commit only/);
  });

  test("same request replay is a no-op; same id with changed inputs conflicts", () => {
    const { vault, id, checkArgs } = checkedCodeNote();
    const replay = ok(cli(vault, ...checkArgs));
    assert.equal(replay.replayed, true);
    const changed = cli(vault, ...checkArgs.map((a) => (a === "supports" ? "contradicts" : a)));
    assert.equal(changed.status, 3);
    assert.equal(fs.readdirSync(path.join(vault, ".wiki/evidence", id)).length, 1);
  });

  test("a distinct check of identical content is retained as new evidence", () => {
    const { vault, id, checkArgs } = checkedCodeNote();
    const second = ok(cli(vault, ...checkArgs.map((a) => (a === `chk-${id}` ? `chk2-${id}` : a))));
    assert.equal(second.replayed, false);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/evidence", id)).sort(), [`chk-${id}.json`, `chk2-${id}.json`]);
  });

  test("old-mtime note edit invalidates the check", () => {
    const { vault, id, noteFile } = checkedCodeNote();
    const before = fs.statSync(noteFile);
    fs.writeFileSync(noteFile, fs.readFileSync(noteFile, "utf8").replace("always", "never"));
    fs.utimesSync(noteFile, before.atime, new Date(before.mtimeMs - 86_400_000));
    const r = ok(cli(vault, "read", id));
    assert.equal(r.status, "changed");
    assert.equal(r.body, "Login never succeeds.\n");
    assert.equal(r.digest, `sha256:${createHash("sha256").update(fs.readFileSync(noteFile)).digest("hex")}`);
    assert.notEqual(r.digest, r.check.noteDigest);
  });

  test("whitespace-only Markdown change is a content change", () => {
    const { vault, id, noteFile } = checkedCodeNote();
    fs.appendFileSync(noteFile, "    ");
    assert.equal(ok(cli(vault, "read", id)).status, "changed");
  });

  test("source deleted at the configured ref reports drift, not attestation", () => {
    const { vault, repo, id } = checkedCodeNote();
    const head = commit(repo, { "src/auth.ts": null, "README.md": "moved\n" }, "delete source");
    const r = ok(cli(vault, "read", id));
    assert.equal(r.status, "changed");
    assert.equal(r.sources[0].state, "changed");
    assert.match(r.sources[0].reason, /missing/);
    assert.equal(r.repos[0].commit, head);
  });

  test("moving ref cannot attest unreviewed content", () => {
    const vault = freshVault();
    const repo = freshRepo({ "lib.ts": "v1\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    ok(cli(vault, "note", "create", "--id", "lib", "--authority", "derived", "--title", "Lib", "--body", "Lib is v1.\n"));
    const obs = ok(cli(vault, "capture", "code", "--repo", "app", "--path", "lib.ts")).observations[0];
    const read = ok(cli(vault, "read", "lib"));
    commit(repo, { "lib.ts": "v2\n" }, "move ref after review");
    ok(cli(vault, "check", "lib", "--note-digest", read.digest, "--source", obs.id, "--outcome", "supports", "--checker", "bob", "--method", "agent", "--request-id", "c1"));
    const r = ok(cli(vault, "read", "lib"));
    assert.equal(r.status, "changed");
    assert.equal(r.sources[0].locator.commit, obs.locator.commit);
  });

  test("check refuses a reviewed note digest that is neither current nor retained", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.ts": "a\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    ok(cli(vault, "note", "create", "--id", "n", "--authority", "derived", "--title", "N", "--body", "reviewed\n"));
    const obs = ok(cli(vault, "capture", "code", "--repo", "app", "--path", "a.ts")).observations[0];
    const reviewed = ok(cli(vault, "read", "n")).digest;
    fs.appendFileSync(path.join(vault, "notes/n.md"), "external unreviewed edit\n");
    const r = cli(vault, "check", "n", "--note-digest", reviewed, "--source", obs.id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "c1");
    assert.equal(r.status, 3);
    assert.equal(ok(cli(vault, "read", "n")).status, "unchecked");
  });

  test("missing repository is unavailable; missing ref is unavailable", () => {
    const a = checkedCodeNote();
    fs.rmSync(a.repo, { recursive: true, force: true });
    const r1 = ok(cli(a.vault, "read", a.id));
    assert.equal(r1.status, "unavailable");
    const b = checkedCodeNote();
    git(b.repo, "branch", "-m", "main", "trunk");
    assert.equal(ok(cli(b.vault, "read", b.id)).status, "unavailable");
  });

  test("contradicting check yields contradicted, never attested", () => {
    const { vault, id, obs, read } = checkedCodeNote();
    ok(cli(vault, "check", id, "--note-digest", read.digest, "--source", obs.id, "--outcome", "contradicts", "--checker", "c", "--method", "human", "--request-id", "later"));
    assert.equal(ok(cli(vault, "read", id)).status, "contradicted");
  });

  test("code path traversal is rejected at the boundary", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.ts": "a\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    assert.equal(cli(vault, "capture", "code", "--repo", "app", "--path", "../etc/passwd").status, 2);
  });
});

describe("damaged evidence fails closed", () => {
  test("truncated check record yields invalid, even with an older valid check", () => {
    const { vault, id, checkArgs } = checkedCodeNote();
    ok(cli(vault, ...checkArgs.map((a) => (a === `chk-${id}` ? "newer" : a))));
    const file = path.join(vault, ".wiki/evidence", id, "newer.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 40));
    const r = ok(cli(vault, "read", id));
    assert.equal(r.status, "invalid");
  });

  test("unsupported check schema yields invalid", () => {
    const { vault, id } = checkedCodeNote();
    const file = path.join(vault, ".wiki/evidence", id, `chk-${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), schema: 2 }));
    assert.equal(ok(cli(vault, "read", id)).status, "invalid");
  });

  test("missing observation and corrupted snapshot blob yield invalid", () => {
    const a = checkedCodeNote();
    fs.rmSync(path.join(a.vault, ".wiki/sources", `${a.obs.id}.json`));
    assert.equal(ok(cli(a.vault, "read", a.id)).status, "invalid");
    const b = checkedCodeNote();
    const hex = b.obs.original.digest.slice("sha256:".length);
    fs.writeFileSync(path.join(b.vault, ".wiki/objects/sha256", hex.slice(0, 2), hex), "tampered");
    assert.equal(ok(cli(b.vault, "read", b.id)).status, "invalid");
  });
});

describe("text import", () => {
  test("retains original bytes and provenance; identical bytes keep distinct observations", () => {
    const vault = freshVault();
    const docs = path.join(temp, `docs-${++counter}`);
    fs.mkdirSync(docs);
    const bytes = "# Notes\r\n\r\nTrailing spaces   \n";
    fs.writeFileSync(path.join(docs, "a.md"), bytes);
    fs.writeFileSync(path.join(docs, "b.txt"), bytes);
    const a = ok(cli(vault, "capture", "text", path.join(docs, "a.md"), "--request-id", "imp-a"));
    const b = ok(cli(vault, "capture", "text", path.join(docs, "b.txt")));
    assert.notEqual(a.observation.id, b.observation.id);
    assert.equal(a.observation.original.digest, b.observation.original.digest);
    assert.equal(a.observation.locator.path, fs.realpathSync(path.join(docs, "a.md")));
    assert.equal(b.observation.locator.path, fs.realpathSync(path.join(docs, "b.txt")));
    assert.deepEqual(a.observation.extracted.extractor, { name: "utf8-text", version: "1" });
    const shown = ok(cli(vault, "source", "show", "imp-a", "--text"));
    assert.equal(shown.text, bytes);
    const replay = ok(cli(vault, "capture", "text", path.join(docs, "a.md"), "--request-id", "imp-a"));
    assert.equal(replay.replayed, true);
    fs.writeFileSync(path.join(docs, "a.md"), "different\n");
    assert.equal(cli(vault, "capture", "text", path.join(docs, "a.md"), "--request-id", "imp-a").status, 3);
  });

  test("text-backed check attests against the retained snapshot", () => {
    const vault = freshVault();
    const file = path.join(temp, `spec-${++counter}.txt`);
    fs.writeFileSync(file, "The limit is 10.\n");
    const obs = ok(cli(vault, "capture", "text", file)).observation;
    ok(cli(vault, "note", "create", "--id", "limit", "--authority", "derived", "--title", "Limit", "--body", "Limit is 10.\n"));
    const digest = ok(cli(vault, "read", "limit")).digest;
    ok(cli(vault, "check", "limit", "--note-digest", digest, "--source", obs.id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "c1"));
    const r = ok(cli(vault, "read", "limit"));
    assert.equal(r.status, "attested");
    assert.equal(r.sources[0].state, "retained");
    assert.equal(r.sources[0].observedAt, obs.observedAt);
  });

  test("unsupported formats and non-UTF-8 text report their limitation", () => {
    const vault = freshVault();
    const docx = path.join(temp, `x-${++counter}.docx`);
    fs.writeFileSync(docx, "PK");
    const r = cli(vault, "capture", "text", docx);
    assert.equal(r.status, 5);
    assert.match(r.json.error.message, /no extractor for \.docx/);
    const bin = path.join(temp, `bin-${++counter}.txt`);
    fs.writeFileSync(bin, Buffer.from([0xff, 0xfe, 0x00]));
    assert.equal(cli(vault, "capture", "text", bin).status, 5);
    assert.equal(fs.existsSync(path.join(vault, ".wiki/sources")), false, "nothing recorded");
  });

  test("personal and record notes refuse checks", () => {
    const vault = freshVault();
    const file = path.join(temp, `p-${++counter}.txt`);
    fs.writeFileSync(file, "x\n");
    const obs = ok(cli(vault, "capture", "text", file)).observation;
    ok(cli(vault, "note", "create", "--id", "mine", "--authority", "personal", "--title", "Mine", "--body", "x\n"));
    const d = ok(cli(vault, "read", "mine")).digest;
    assert.equal(cli(vault, "check", "mine", "--note-digest", d, "--source", obs.id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "c").status, 2);
  });
});

describe("acceptance: bound repository identity", () => {
  test("remapping a repo key to another repo with identical bytes invalidates its check", () => {
    const { vault, id } = checkedCodeNote();
    const replacement = freshRepo({ "src/auth.ts": "export const login = () => true;\n" });
    ok(cli(vault, "repo", "add", "app", "--path", replacement, "--ref", "main"));
    const read = ok(cli(vault, "read", id));
    assert.equal(read.status, "changed");
    assert.match(read.sources[0].reason, /binding/);
  });

  test("switching a configured ref to an identical branch invalidates its check", () => {
    const { vault, repo, id } = checkedCodeNote();
    git(repo, "branch", "review-branch", "main");
    ok(cli(vault, "repo", "add", "app", "--path", repo, "--ref", "review-branch"));
    assert.equal(ok(cli(vault, "read", id)).status, "changed");
  });
});

describe("acceptance: complete retained evidence validation", () => {
  for (const [label, checker] of [
    ["unrecognized checker method", { name: "alice", method: "oracle", authenticated: false }],
    ["claimed authenticated identity", { name: "alice", method: "human", authenticated: true }],
    ["missing checker provenance", { name: "alice" }],
    ["empty checker", { name: "", method: "human", authenticated: false }],
  ] as const) {
    test(label, () => {
      const { vault, id } = checkedCodeNote();
      const file = path.join(vault, ".wiki/evidence", id, `chk-${id}.json`);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...record, checker }));
      assert.equal(ok(cli(vault, "read", id)).status, "invalid");
    });
  }

  for (const [label, mutate] of [
    ["invalid observation time", (r: any) => { r.observedAt = "not-a-time"; }],
    ["wrong code scope", (r: any) => { r.locator.scope = "remote-current"; }],
    ["traversing code path", (r: any) => { r.locator.path = "../sentinel"; }],
    ["missing repository binding identity", (r: any) => { delete r.locator.repoPath; }],
    ["wrong original byte count", (r: any) => { r.original.size += 1; }],
  ] as const) {
    test(label, () => {
      const { vault, id, obs } = checkedCodeNote();
      const file = path.join(vault, ".wiki/sources", `${obs.id}.json`);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      mutate(record);
      fs.writeFileSync(file, JSON.stringify(record));
      assert.equal(ok(cli(vault, "read", id)).status, "invalid");
    });
  }

  test("missing extractor provenance cannot attest retained text", () => {
    const vault = freshVault();
    const file = path.join(temp, `provenance-${++counter}.txt`);
    fs.writeFileSync(file, "Claim source.\n");
    const obs = ok(cli(vault, "capture", "text", file, "--request-id", "src")).observation;
    const note = ok(cli(vault, "note", "create", "--id", "n", "--authority", "derived", "--title", "N", "--body", "Claim.\n"));
    ok(cli(vault, "check", "n", "--note-digest", note.digest, "--source", obs.id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "c"));
    const recordPath = path.join(vault, ".wiki/sources/src.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.extracted.extractor = {};
    fs.writeFileSync(recordPath, JSON.stringify(record));
    assert.equal(ok(cli(vault, "read", "n")).status, "invalid");
  });

  test("a missing retained reviewed note cannot yield positive evidence", () => {
    const { vault, id, read } = checkedCodeNote();
    const hex = read.digest.slice("sha256:".length);
    fs.rmSync(path.join(vault, ".wiki/objects/sha256", hex.slice(0, 2), hex));
    assert.equal(ok(cli(vault, "read", id)).status, "invalid");
  });
});

describe("acceptance: safe Obsidian YAML", () => {
  test("inline comments and quoted scalars preserve authored identity and body", () => {
    const vault = freshVault();
    fs.writeFileSync(path.join(vault, "notes/edited.md"), "---\nid: edited # identity\nauthority: derived # evidence-backed\ntitle: 'Owner''s note' # title\ntags: [one, two]\ntrust: attested # untrusted\n---\nBody with  two spaces.\n");
    const read = ok(cli(vault, "read", "edited"));
    assert.equal(read.status, "unchecked");
    assert.equal(read.title, "Owner's note");
    assert.equal(read.body, "Body with  two spaces.\n");
    assert.ok(read.reasons.some((reason: string) => reason.includes('"trust"')));
  });

  test("escaped quoted identity is found without a raw-byte prefilter", () => {
    const vault = freshVault();
    fs.writeFileSync(path.join(vault, "notes/renamed.md"), String.raw`---
id: "\u0065scaped"
authority: personal
---
An idea.
`);
    assert.equal(ok(cli(vault, "read", "escaped")).status, "owner-authored");
    assert.equal(cli(vault, "note", "create", "--id", "escaped", "--authority", "personal", "--title", "Another", "--body", "other").status, 3);
  });

  test("non-data frontmatter is never evaluated", () => {
    const vault = freshVault();
    fs.writeFileSync(path.join(vault, "notes/script.md"), '---js\n(() => { throw new Error("EXECUTED_FRONTMATTER"); })()\n---\nbody\n');
    const result = cli(vault, "read", "script");
    assert.equal(result.status, 4);
    assert.equal(result.stderr.includes("EXECUTED_FRONTMATTER"), false);
    fs.rmSync(path.join(vault, "notes/script.md"));
    fs.writeFileSync(path.join(vault, "notes/tagged.md"), '---\nid: tagged\nauthority: derived\nfunction: !!js/function "function () { return 42; }"\n---\nbody\n');
    assert.equal(cli(vault, "read", "tagged").status, 2, "unsafe YAML tags are rejected");
  });
});

describe("acceptance: referenced note snapshots", () => {
  test("captures exact note bytes, survives rename, and detects old-mtime source edits", () => {
    const vault = freshVault();
    const source = ok(cli(vault, "note", "create", "--id", "idea", "--authority", "personal", "--title", "Idea", "--body", "Owner says ten.\n"));
    const sourceFile = path.join(vault, source.path);
    const original = fs.readFileSync(sourceFile);
    const capture = ok(cli(vault, "capture", "note", "idea", "--request-id", "idea-snapshot"));
    assert.equal(capture.observation.locator.kind, "note");
    assert.equal(capture.observation.locator.noteId, "idea");
    assert.equal(capture.observation.locator.noteDigest, source.digest);
    assert.equal(capture.observation.original.digest, source.digest);
    assert.equal(ok(cli(vault, "source", "show", "idea-snapshot", "--text")).text, original.toString("utf8"));
    assert.equal(ok(cli(vault, "capture", "note", "idea", "--request-id", "idea-snapshot")).replayed, true);
    const second = ok(cli(vault, "capture", "note", "idea", "--request-id", "another-observation"));
    assert.equal(second.replayed, false);
    assert.equal(second.observation.original.digest, source.digest);
    const target = ok(cli(vault, "note", "create", "--id", "derived", "--authority", "derived", "--title", "Derived", "--body", "The idea mentions ten.\n"));
    ok(cli(vault, "check", "derived", "--note-digest", target.digest, "--source", "idea-snapshot", "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "review"));
    assert.equal(ok(cli(vault, "read", "derived")).status, "attested");
    const renamed = path.join(vault, "renamed.md");
    fs.renameSync(sourceFile, renamed);
    assert.equal(ok(cli(vault, "read", "derived")).status, "attested");
    const before = fs.statSync(renamed);
    fs.appendFileSync(renamed, "An external edit.\n");
    fs.utimesSync(renamed, before.atime, before.mtime);
    const read = ok(cli(vault, "read", "derived"));
    assert.equal(read.status, "changed");
    assert.equal(read.sources[0].locator.noteDigest, source.digest);
    assert.equal(ok(cli(vault, "source", "show", "idea-snapshot", "--text")).text, original.toString("utf8"));
    assert.equal(cli(vault, "capture", "note", "idea", "--request-id", "idea-snapshot").status, 3);
    fs.rmSync(renamed);
    assert.equal(ok(cli(vault, "read", "derived")).status, "unavailable");
  });

  test("moving a referenced note after review cannot attest its unreviewed revision", () => {
    const vault = freshVault();
    const note = ok(cli(vault, "note", "create", "--id", "source", "--authority", "record", "--title", "Source", "--body", "Observation zero.\n"));
    const observation = ok(cli(vault, "capture", "note", "source")).observation;
    const target = ok(cli(vault, "note", "create", "--id", "target", "--authority", "derived", "--title", "Target", "--body", "Recorded zero.\n"));
    fs.appendFileSync(path.join(vault, note.path), "Observation one.\n");
    ok(cli(vault, "check", "target", "--note-digest", target.digest, "--source", observation.id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "c"));
    assert.equal(ok(cli(vault, "read", "target")).status, "changed");
    assert.equal(cli(vault, "capture", "note", "../source").status, 2);
  });
});

describe("acceptance: immutable local commit and locator isolation", () => {
  test("capture and read each resolve a moving branch once for all code paths", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.txt": "A zero\n", "b.txt": "B zero\n" });
    const zero = git(repo, "rev-parse", "HEAD");
    const one = commit(repo, { "a.txt": "A one\n", "b.txt": "B one\n" }, "one");
    git(repo, "update-ref", "refs/heads/main", zero);
    fs.writeFileSync(path.join(repo, "a.txt"), "Uncommitted text.\n");
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    const wrappers = path.join(temp, `git-wrapper-${++counter}`);
    fs.mkdirSync(wrappers);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const log = path.join(wrappers, "commands.jsonl");
    const marker = path.join(wrappers, "moved");
    fs.writeFileSync(path.join(wrappers, "git"), `#!${process.execPath}\n` + `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args);
if (args.includes('cat-file') && !fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'moved');
  const move = spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(repo)}, 'update-ref', 'refs/heads/main', ${JSON.stringify(one)}]);
  if (move.status !== 0) process.exit(move.status || 1);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status || 0);
`, { mode: 0o755 });
    const wrapped = (...args: string[]) => {
      const result = spawnSync(process.execPath, [BIN, "--vault", vault, "--json", ...args], {
        encoding: "utf8", env: { ...process.env, WIKI_VAULT: "", PATH: `${wrappers}${path.delimiter}${process.env.PATH}` },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const capture = wrapped("capture", "code", "--repo", "app", "--path", "a.txt", "--path", "b.txt", "--request-id", "two-files");
    assert.deepEqual(capture.observations.map((o: any) => o.locator.commit), [zero, zero]);
    const [firstSource, secondSource] = capture.observations;
    assert.equal(ok(cli(vault, "source", "show", firstSource.id, "--text")).text, "A zero\n");
    assert.equal(ok(cli(vault, "source", "show", secondSource.id, "--text")).text, "B zero\n");
    assert.equal(git(repo, "rev-parse", "main"), one);
    const note = ok(cli(vault, "note", "create", "--id", "two", "--authority", "derived", "--title", "Two", "--body", "Both say zero.\n"));
    ok(cli(vault, "check", "two", "--note-digest", note.digest, "--source", firstSource.id, "--source", secondSource.id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "two-check"));
    git(repo, "update-ref", "refs/heads/main", zero);
    fs.rmSync(marker);
    fs.writeFileSync(log, "");
    const read = wrapped("read", "two");
    assert.equal(read.status, "attested");
    assert.equal(read.repos.length, 1);
    assert.equal(read.repos[0].commit, zero);
    const commands: string[][] = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(commands.filter((args) => args.includes("--verify")).length, 1);
    assert.equal(ok(cli(vault, "read", "two")).status, "changed", "next read observes moved main without guessing contradiction");
  });

  test("source IDs and code locators cannot select arbitrary local files", () => {
    const vault = freshVault();
    const sentinel = path.join(temp, `sentinel-${++counter}.txt`);
    fs.writeFileSync(sentinel, "Outside sentinel.\n");
    const repo = freshRepo({ "safe.txt": "safe\n" });
    fs.symlinkSync(sentinel, path.join(repo, "link.txt"));
    git(repo, "add", "link.txt");
    git(repo, "commit", "-q", "-m", "link");
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    for (const locator of ["../sentinel.txt", sentinel, "a/../../sentinel.txt", "a\\..\\sentinel.txt"]) {
      assert.equal(cli(vault, "capture", "code", "--repo", "app", "--path", locator).status, 2);
    }
    for (const id of ["../sentinel", sentinel, "%2e%2e%2fsentinel"]) assert.equal(cli(vault, "source", "show", id, "--text").status, 2);
    const link = ok(cli(vault, "capture", "code", "--repo", "app", "--path", "link.txt")).observations[0];
    assert.equal(ok(cli(vault, "source", "show", link.id, "--text")).text, sentinel, "a Git symlink blob is the link target string, not its external contents");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "Outside sentinel.\n");
    for (const repoKey of ["missing", "constructor", "toString"]) {
      assert.equal(cli(vault, "capture", "code", "--repo", repoKey, "--path", "safe.txt").status, 7);
    }
  });
});

describe("acceptance: missing bindings and lifecycle status", () => {
  test("removing a repository binding does not default to another source path", () => {
    const { vault, id } = checkedCodeNote();
    fs.writeFileSync(path.join(vault, ".wiki/vault.json"), JSON.stringify({ schema: 1, repos: {} }));
    const read = ok(cli(vault, "read", id));
    assert.equal(read.status, "unavailable");
    assert.match(read.sources[0].reason, /not configured/);
    assert.equal(read.body, "Login always succeeds.\n");
  });

  test("an unknown source schema is invalid evidence, not a retained positive snapshot", () => {
    const { vault, id, obs } = checkedCodeNote();
    const file = path.join(vault, ".wiki/sources", `${obs.id}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...record, schema: 99 }));
    assert.equal(ok(cli(vault, "read", id)).status, "invalid");
  });

  test("owner-authored supersession marks an intent note non-current without approving it", () => {
    const vault = freshVault();
    fs.writeFileSync(path.join(vault, "notes/old-policy.md"), '---\nid: old-policy\nauthority: intent\nsuperseded_by: new-policy\ntrust: attested\n---\nAn old policy.\n');
    const read = ok(cli(vault, "read", "old-policy"));
    assert.equal(read.status, "superseded");
    assert.equal(read.check, null);
    assert.equal(read.body, "An old policy.\n");
  });
});

describe("review R1: Git replacement refs", () => {
  test("changing replacement refs between blob lookups cannot change immutable evidence", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.txt": "A zero\n", "b.txt": "B zero\n" });
    const zero = git(repo, "rev-parse", "HEAD");
    const one = commit(repo, { "a.txt": "A one\n", "b.txt": "B one\n" }, "replacement");
    git(repo, "update-ref", "refs/heads/main", zero);
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    const wrapperDir = path.join(temp, `replace-wrapper-${++counter}`);
    fs.mkdirSync(wrapperDir);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const marker = path.join(wrapperDir, "replaced");
    const log = path.join(wrapperDir, "commands.jsonl");
    fs.writeFileSync(path.join(wrapperDir, "git"), `#!${process.execPath}\n` + `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args);
if (args.includes('cat-file') && !fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'replaced');
  const change = spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(repo)}, 'replace', ${JSON.stringify(zero)}, ${JSON.stringify(one)}]);
  if (change.status !== 0) process.exit(change.status || 1);
}
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status || 0);
`, { mode: 0o755 });
    const captured = spawnSync(process.execPath, [BIN, "--vault", vault, "--json", "capture", "code", "--repo", "app", "--path", "a.txt", "--path", "b.txt", "--request-id", "replacement-race"], {
      encoding: "utf8", env: { ...process.env, WIKI_VAULT: "", PATH: `${wrapperDir}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(captured.status, 0, captured.stderr);
    const observations = JSON.parse(captured.stdout).observations;
    assert.deepEqual(observations.map((o: any) => o.locator.commit), [zero, zero]);
    assert.equal(git(repo, "rev-parse", "main"), zero, "the configured branch never moved");
    assert.equal(ok(cli(vault, "source", "show", observations[0].id, "--text")).text, "A zero\n");
    assert.equal(ok(cli(vault, "source", "show", observations[1].id, "--text")).text, "B zero\n");
    const note = ok(cli(vault, "note", "create", "--id", "replacement", "--authority", "derived", "--title", "Replacement", "--body", "Both say zero.\n"));
    ok(cli(vault, "check", "replacement", "--note-digest", note.digest, "--source", observations[0].id, "--source", observations[1].id, "--outcome", "supports", "--checker", "a", "--method", "human", "--request-id", "replacement-check"));
    assert.equal(ok(cli(vault, "read", "replacement")).status, "attested", "reads also ignore replacement commits");
    const blobZero = git(repo, "--no-replace-objects", "rev-parse", `${zero}:b.txt`);
    const blobOne = git(repo, "--no-replace-objects", "rev-parse", `${one}:b.txt`);
    git(repo, "replace", blobZero, blobOne);
    assert.equal(ok(cli(vault, "read", "replacement")).status, "attested", "blob replacement is also disabled");
    const commands: string[][] = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(commands.every((args) => args.includes("--no-replace-objects")));
  });
});

describe("review R4: complete code capture request identity", () => {
  for (const [label, initial, changed] of [
    ["growing path list", ["a.txt"], ["a.txt", "b.txt"]],
    ["shrinking path list", ["a.txt", "b.txt"], ["a.txt"]],
    ["reordered path list", ["a.txt", "b.txt"], ["b.txt", "a.txt"]],
  ] as const) {
    test(label, () => {
      const vault = freshVault();
      const repo = freshRepo({ "a.txt": "A\n", "b.txt": "B\n" });
      ok(cli(vault, "repo", "add", "app", "--path", repo));
      const args = (paths: readonly string[]) => ["capture", "code", "--repo", "app", ...paths.flatMap((p) => ["--path", p]), "--request-id", "batch"];
      ok(cli(vault, ...args(initial)));
      const sources = path.join(vault, ".wiki/sources");
      const before = fs.readdirSync(sources).sort().map((name) => [name, fs.readFileSync(path.join(sources, name), "utf8")]);
      assert.equal(cli(vault, ...args(changed)).status, 3, "the full ordered input is part of the request");
      assert.deepEqual(fs.readdirSync(sources).sort().map((name) => [name, fs.readFileSync(path.join(sources, name), "utf8")]), before, "conflict has no additional source effect");
    });
  }

  test("a batch request never aliases a different observation request's ordinal-looking ID", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.txt": "A\n", "b.txt": "B\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    const file = path.join(temp, `ordinal-${++counter}.txt`);
    fs.writeFileSync(file, "Independent import.\n");
    const existing = ok(cli(vault, "capture", "text", file, "--request-id", "batch.1")).observation;
    const captured = ok(cli(vault, "capture", "code", "--repo", "app", "--path", "a.txt", "--path", "b.txt", "--request-id", "batch"));
    assert.equal(captured.observations.length, 2);
    assert.ok(captured.observations.every((o: any) => o.id !== existing.id));
    assert.equal(ok(cli(vault, "source", "show", existing.id, "--text")).text, "Independent import.\n");
  });
});

describe("review R4: interrupted capture recovery", () => {
  for (const stopBeforeEffect of [1, 2]) test(`an identical batch resumes after interruption before source effect ${stopBeforeEffect}`, async () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.txt": "A\n", "b.txt": "B\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    const coreUrl = new URL("../../wiki-core/src/index.ts", import.meta.url).href;
    const script = `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const realLink = fs.linkSync;
let sources = 0;
fs.linkSync = (source, target) => {
  if (target.includes('/sources/') && ++sources === ${stopBeforeEffect}) {
    fs.writeSync(1, 'second-effect-pending\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return realLink(source, target);
};
syncBuiltinESMExports();
import(${JSON.stringify(coreUrl)}).then(core => core.captureCode(core.openVault(${JSON.stringify(vault)}), 'app', ['a.txt', 'b.txt'], 'resume-batch'));`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    let boundIds: string[] = [];
    try {
      const [event] = await once(lines, "line");
      assert.equal(event, "second-effect-pending");
      const claim = JSON.parse(fs.readFileSync(path.join(vault, ".wiki/code-requests/resume-batch.json"), "utf8"));
      boundIds = claim.files.map((f: any) => f.observationId);
      assert.equal(boundIds.length, 2);
      assert.equal(fs.existsSync(path.join(vault, ".wiki/sources")) ? fs.readdirSync(path.join(vault, ".wiki/sources")).length : 0, stopBeforeEffect - 1);
    } finally {
      child.kill("SIGKILL");
      await closed;
      lines.close();
    }
    const args = ["capture", "code", "--repo", "app", "--path", "a.txt", "--path", "b.txt", "--request-id", "resume-batch"];
    const resumed = ok(cli(vault, ...args));
    assert.deepEqual(resumed.observations.map((o: any) => o.id), boundIds);
    assert.deepEqual(resumed.observations.map((o: any) => o.replayed), stopBeforeEffect === 1 ? [false, false] : [true, false]);
    assert.equal(fs.readdirSync(path.join(vault, ".wiki/sources")).length, 2);
    assert.ok(ok(cli(vault, ...args)).observations.every((o: any) => o.replayed));
  });

  test("a damaged batch claim fails closed before another source effect", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.txt": "A\n", "b.txt": "B\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    const args = ["capture", "code", "--repo", "app", "--path", "a.txt", "--path", "b.txt", "--request-id", "damaged-batch"];
    const original = ok(cli(vault, ...args));
    const before = original.observations.map((o: any) => ok(cli(vault, "source", "show", o.id)));
    fs.writeFileSync(path.join(vault, ".wiki/code-requests/damaged-batch.json"), '{"schema":1,');
    assert.equal(cli(vault, ...args).status, 6);
    assert.deepEqual(original.observations.map((o: any) => ok(cli(vault, "source", "show", o.id))), before);
    assert.equal(fs.readdirSync(path.join(vault, ".wiki/sources")).length, 2);
  });

  test("a changed immutable capture snapshot conflicts without adding sources", () => {
    const vault = freshVault();
    const repo = freshRepo({ "a.txt": "A zero\n", "b.txt": "B zero\n" });
    ok(cli(vault, "repo", "add", "app", "--path", repo));
    const args = ["capture", "code", "--repo", "app", "--path", "a.txt", "--path", "b.txt", "--request-id", "immutable-batch"];
    ok(cli(vault, ...args));
    const before = fs.readdirSync(path.join(vault, ".wiki/sources")).sort();
    commit(repo, { "b.txt": "B one\n" }, "changed snapshot");
    assert.equal(cli(vault, ...args).status, 3);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".wiki/sources")).sort(), before);
  });
});
