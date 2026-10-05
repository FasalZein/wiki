import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { createNote, importTextFile, initVault, readNote, recordCheck, WikiError } from "../src/index.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-check-acceptance-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function fixture() {
  const vault = initVault(path.join(temp, `vault-${++counter}`));
  const file = path.join(temp, `source-${counter}.txt`);
  fs.writeFileSync(file, "The limit is 10.\n");
  const source = importTextFile(vault, file).observation;
  const note = createNote(vault, { id: "limit", authority: "derived", title: "Limit", body: "The limit is 10.\n" });
  return { vault, input: { noteId: note.id, noteDigest: note.digest, sourceIds: [source.id], checker: "alice", method: "human" as const } };
}

test("equal-time contradictory checks cannot select a positive outcome by request spelling", () => {
  const { vault, input } = fixture();
  const recordedAt = "2026-10-05T12:00:00.000Z";
  recordCheck(vault, { ...input, requestId: "z-supports", outcome: "supports", recordedAt });
  recordCheck(vault, { ...input, requestId: "a-contradicts", outcome: "contradicts", recordedAt });
  const read = readNote(vault, "limit");
  assert.equal(read.status, "invalid");
  assert.match(read.reasons.join("\n"), /ambiguous/);
  recordCheck(vault, { ...input, requestId: "later-review", outcome: "supports", recordedAt: "2026-10-05T12:00:01.000Z" });
  assert.equal(readNote(vault, "limit").status, "attested", "a genuinely later decisive review resolves the tie");
});

test("same request on another note conflicts rather than creating a second check", () => {
  const { vault, input } = fixture();
  recordCheck(vault, { ...input, requestId: "one-request", outcome: "supports" });
  const other = createNote(vault, { id: "other", authority: "derived", title: "Other", body: "Another claim.\n" });
  assert.throws(() => recordCheck(vault, { ...input, noteId: other.id, noteDigest: other.digest, requestId: "one-request", outcome: "supports" }),
    (error: unknown) => error instanceof WikiError && error.code === "conflict");
  assert.equal(readNote(vault, "other").status, "unchecked");
});

test("distinct reviewers of identical content keep provenance while exact request replay keeps its first time", () => {
  const { vault, input } = fixture();
  const firstInput = { ...input, requestId: "first", outcome: "supports" as const, recordedAt: "2026-10-05T12:00:00.000Z" };
  const first = recordCheck(vault, firstInput);
  const replay = recordCheck(vault, { ...firstInput, recordedAt: "2026-10-06T12:00:00.000Z" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.check, first.check);
  assert.throws(() => recordCheck(vault, { ...firstInput, checker: "bob" }), (error: unknown) => error instanceof WikiError && error.code === "conflict");
  const second = recordCheck(vault, { ...firstInput, requestId: "second", checker: "bob", method: "agent", recordedAt: "2026-10-05T12:00:01.000Z" });
  assert.equal(second.replayed, false);
  assert.equal(second.check.noteDigest, first.check.noteDigest);
  assert.deepEqual(second.check.sources, first.check.sources);
  assert.deepEqual(readNote(vault, "limit").check?.checker, { name: "bob", method: "agent", authenticated: false });
});

test("recording an already retained reviewed revision does not sample or overwrite an external edit", () => {
  const { vault, input } = fixture();
  recordCheck(vault, { ...input, requestId: "retains-zero", outcome: "supports", recordedAt: "2026-10-05T12:00:00.000Z" });
  const file = path.join(vault.root, "notes/limit.md");
  fs.appendFileSync(file, "An unreviewed external change.\n");
  const edited = fs.readFileSync(file);
  const later = recordCheck(vault, { ...input, requestId: "reviewed-zero", outcome: "supports", recordedAt: "2026-10-05T12:00:01.000Z" });
  assert.equal(later.check.noteDigest, input.noteDigest);
  assert.deepEqual(fs.readFileSync(file), edited);
  const read = readNote(vault, "limit");
  assert.equal(read.status, "changed");
  assert.equal(read.check?.noteDigest, input.noteDigest);
  assert.match(read.body, /unreviewed external change/);
});
