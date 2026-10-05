// Spawns the real CLI under Node against disposable vaults and Git repositories.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
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
    assert.match(r.body, /never/);
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
