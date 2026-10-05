import * as fs from "node:fs";
import * as path from "node:path";
import { loadNote } from "./notes.ts";
import { evidenceDigest, loadObservation, verifyObservationBlobs } from "./sources.ts";
import {
  canonicalJson,
  createFileExclusive,
  getBlob,
  hasBlob,
  isDigest,
  isObject,
  putBlob,
  readJsonRecord,
  type Vault,
  wikiPath,
} from "./store.ts";
import { assertNoteId, assertRequestId, type Digest, SCHEMA_VERSION, WikiError } from "./types.ts";

export const CHECK_OUTCOMES = ["supports", "contradicts"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];
export const CHECK_METHODS = ["human", "agent"] as const;
export type CheckMethod = (typeof CHECK_METHODS)[number];

export interface CheckRecord {
  schema: typeof SCHEMA_VERSION;
  /** Request identity of this check; distinct from every content digest. */
  id: string;
  noteId: string;
  /** Digest of the exact note bytes the checker reviewed. */
  noteDigest: Digest;
  sources: { observationId: string; digest: Digest }[];
  outcome: CheckOutcome;
  /** Asserted by the caller. Provenance only; not authenticated identity. */
  checker: { name: string; method: CheckMethod; authenticated: false };
  recordedAt: string;
}

export interface RecordCheckInput {
  requestId: string;
  noteId: string;
  noteDigest: string;
  sourceIds: string[];
  outcome: CheckOutcome;
  checker: string;
  method: CheckMethod;
  recordedAt?: string;
}

function evidenceDir(vault: Vault, noteId: string): string {
  return wikiPath(vault, "evidence", assertNoteId(noteId));
}

/**
 * Record a check of a reviewed note revision against immutable source snapshots.
 * The note revision must be the current file or an already retained snapshot; the core
 * never substitutes the current file for a different reviewed digest.
 */
export function recordCheck(vault: Vault, input: RecordCheckInput): { check: CheckRecord; replayed: boolean } {
  assertRequestId(input.requestId);
  if (!isDigest(input.noteDigest)) throw new WikiError("invalid_input", `note digest must be sha256:<hex>: ${input.noteDigest}`);
  if (!CHECK_OUTCOMES.includes(input.outcome)) throw new WikiError("invalid_input", `outcome must be one of ${CHECK_OUTCOMES.join(", ")}`);
  if (!CHECK_METHODS.includes(input.method)) throw new WikiError("invalid_input", `method must be one of ${CHECK_METHODS.join(", ")}`);
  if (input.checker.trim() === "") throw new WikiError("invalid_input", "checker name is required");
  if (input.sourceIds.length === 0) throw new WikiError("invalid_input", "a check needs at least one source observation");

  const note = loadNote(vault, input.noteId);
  if (note.authority === "personal" || note.authority === "record") {
    throw new WikiError("invalid_input", `${note.authority} notes are not checked against sources`);
  }
  const sources = input.sourceIds.map((id) => {
    const observation = loadObservation(vault, id);
    verifyObservationBlobs(vault, observation);
    return { observationId: id, digest: evidenceDigest(observation) };
  });

  const check: CheckRecord = {
    schema: SCHEMA_VERSION,
    id: input.requestId,
    noteId: note.id,
    noteDigest: input.noteDigest,
    sources,
    outcome: input.outcome,
    checker: { name: input.checker, method: input.method, authenticated: false },
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };

  // Replay before any write: same id anywhere in the evidence log.
  const existing = findCheckFile(vault, input.requestId);
  if (existing) {
    const prior = readJsonRecord(existing) as unknown as CheckRecord;
    const same = (c: CheckRecord) => canonicalJson({ ...c, recordedAt: null });
    if (same(prior) !== same(check)) {
      throw new WikiError("conflict", `check request ${input.requestId} already recorded different inputs`);
    }
    return { check: prior, replayed: true };
  }

  if (note.digest === input.noteDigest) {
    putBlob(vault, note.bytes);
  } else if (hasBlob(vault, input.noteDigest)) {
    getBlob(vault, input.noteDigest);
  } else {
    throw new WikiError(
      "conflict",
      `reviewed note revision ${input.noteDigest} is neither current (${note.digest}) nor retained; read and review the current note`,
    );
  }

  const file = path.join(evidenceDir(vault, note.id), `${input.requestId}.json`);
  if (!createFileExclusive(vault, file, `${JSON.stringify(check, null, 2)}\n`)) {
    throw new WikiError("conflict", `check request ${input.requestId} was recorded concurrently`);
  }
  return { check, replayed: false };
}

function findCheckFile(vault: Vault, requestId: string): string | null {
  const root = wikiPath(vault, "evidence");
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${requestId}.json`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Load every check of a note. Any malformed, truncated, or unsupported record throws, so a
 * damaged newer record cannot let an older positive check decide the status.
 */
export function loadChecks(vault: Vault, noteId: string): CheckRecord[] {
  const dir = evidenceDir(vault, noteId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => {
    const file = path.join(dir, name);
    const r = readJsonRecord(file);
    const bad = (why: string) => new WikiError("damaged", `check record ${name} is malformed: ${why}`);
    if (`${String(r.id)}.json` !== name) throw bad("id does not match file name");
    if (r.noteId !== noteId) throw bad("noteId does not match evidence directory");
    if (!isDigest(r.noteDigest)) throw bad("noteDigest");
    if (!CHECK_OUTCOMES.includes(r.outcome as CheckOutcome)) throw bad("outcome");
    if (typeof r.recordedAt !== "string" || Number.isNaN(Date.parse(r.recordedAt))) throw bad("recordedAt");
    if (!isObject(r.checker) || typeof r.checker.name !== "string") throw bad("checker");
    if (!Array.isArray(r.sources) || r.sources.length === 0) throw bad("sources");
    for (const s of r.sources) {
      if (!isObject(s) || typeof s.observationId !== "string" || !isDigest(s.digest)) throw bad("source entry");
    }
    return r as unknown as CheckRecord;
  });
}

/** Most recent check by recording time; ties break on id for determinism. */
export function latestCheck(checks: CheckRecord[]): CheckRecord | null {
  let latest: CheckRecord | null = null;
  for (const c of checks) {
    if (!latest) latest = c;
    else {
      const d = Date.parse(c.recordedAt) - Date.parse(latest.recordedAt);
      if (d > 0 || (d === 0 && c.id > latest.id)) latest = c;
    }
  }
  return latest;
}
