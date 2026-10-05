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

  if (Number.isNaN(Date.parse(check.recordedAt))) throw new WikiError("invalid_input", "recordedAt must be a valid time");
  if (note.digest !== input.noteDigest) {
    if (hasBlob(vault, input.noteDigest)) getBlob(vault, input.noteDigest);
    else throw new WikiError("conflict", `reviewed note revision ${input.noteDigest} is neither current (${note.digest}) nor retained; read and review the current note`);
  }

  // One immutable vault-wide claim selects the inputs and recording time before note effects.
  // A claim is not completion: an identical writer can finish its missing evidence record.
  const claimFile = checkRequestFile(vault, input.requestId);
  let claimed = check;
  if (!createFileExclusive(vault, claimFile, `${JSON.stringify(check, null, 2)}\n`)) {
    claimed = loadCheckRequest(vault, input.requestId);
    const identity = (c: CheckRecord) => canonicalJson({ ...c, recordedAt: null });
    if (identity(claimed) !== identity(check)) {
      throw new WikiError("conflict", `check request ${input.requestId} already recorded different inputs`);
    }
  }
  const file = path.join(evidenceDir(vault, claimed.noteId), `${claimed.id}.json`);
  if (fs.existsSync(file)) {
    verifyCheckEffect(vault, claimed, file);
    getBlob(vault, claimed.noteDigest);
    return { check: claimed, replayed: true };
  }
  if (note.digest === claimed.noteDigest) putBlob(vault, note.bytes);
  getBlob(vault, claimed.noteDigest);
  const created = createFileExclusive(vault, file, `${JSON.stringify(claimed, null, 2)}\n`);
  if (!created) verifyCheckEffect(vault, claimed, file);
  return { check: claimed, replayed: !created };
}

function checkRequestFile(vault: Vault, id: string): string {
  return wikiPath(vault, "check-requests", `${assertRequestId(id)}.json`);
}

function loadCheckRequest(vault: Vault, id: string): CheckRecord {
  const raw = readJsonRecord(checkRequestFile(vault, id));
  if (typeof raw.noteId !== "string") throw new WikiError("damaged", `check request ${id} has no note identity`);
  return parseCheck(raw, `${id}.json`, raw.noteId);
}

function verifyCheckEffect(vault: Vault, claimed: CheckRecord, file: string): void {
  const effect = parseCheck(readJsonRecord(file), `${claimed.id}.json`, claimed.noteId);
  if (canonicalJson(effect) !== canonicalJson(claimed)) {
    throw new WikiError("damaged", `check effect ${claimed.id} differs from its vault-wide request claim`);
  }
}

/**
 * Load every check of a note. Any malformed, truncated, or unsupported record throws, so a
 * damaged newer record cannot let an older positive check decide the status.
 */
export function loadChecks(vault: Vault, noteId: string): CheckRecord[] {
  const dir = evidenceDir(vault, noteId);
  const checks = fs.existsSync(dir)
    ? fs.readdirSync(dir).map((name) => parseCheck(readJsonRecord(path.join(dir, name)), name, noteId))
    : [];
  for (const check of checks) {
    const claimed = loadCheckRequest(vault, check.id);
    if (canonicalJson(claimed) !== canonicalJson(check)) throw new WikiError("damaged", `check ${check.id} differs from its request claim`);
  }
  const requests = wikiPath(vault, "check-requests");
  if (fs.existsSync(requests)) {
    // An undecodable global claim has unknown relevance; fail closed rather than skip it.
    for (const name of fs.readdirSync(requests)) {
      if (!name.endsWith(".json")) throw new WikiError("damaged", `malformed check request filename ${name}`);
      const claimed = loadCheckRequest(vault, name.slice(0, -5));
      if (claimed.noteId === noteId && !checks.some((c) => c.id === claimed.id)) {
        throw new WikiError("damaged", `check request ${claimed.id} is incomplete: evidence record is missing`);
      }
    }
  }
  return checks;
}

function parseCheck(r: Record<string, unknown>, name: string, noteId: string): CheckRecord {
  const bad = (why: string) => new WikiError("damaged", `check record ${name} is malformed: ${why}`);
  try { assertNoteId(noteId); } catch { throw bad("noteId"); }
  if (typeof r.id !== "string") throw bad("id");
  try { assertRequestId(r.id); } catch { throw bad("id"); }
  if (`${r.id}.json` !== name) throw bad("id does not match file name");
  if (r.noteId !== noteId) throw bad("noteId does not match evidence directory");
  if (!isDigest(r.noteDigest)) throw bad("noteDigest");
  if (r.outcome !== "supports" && r.outcome !== "contradicts") throw bad("outcome");
  if (typeof r.recordedAt !== "string" || Number.isNaN(Date.parse(r.recordedAt))) throw bad("recordedAt");
  const checker = r.checker;
  if (!isObject(checker) || typeof checker.name !== "string" || checker.name.trim() === "" ||
      (checker.method !== "human" && checker.method !== "agent") || checker.authenticated !== false) throw bad("checker provenance");
  if (!Array.isArray(r.sources) || r.sources.length === 0) throw bad("sources");
  const sources = r.sources.map((s: unknown) => {
    if (!isObject(s) || typeof s.observationId !== "string" || !isDigest(s.digest)) throw bad("source entry");
    try { assertRequestId(s.observationId); } catch { throw bad("source observation id"); }
    return { observationId: s.observationId, digest: s.digest };
  });
  return {
    schema: SCHEMA_VERSION, id: r.id, noteId, noteDigest: r.noteDigest, sources, outcome: r.outcome,
    checker: { name: checker.name, method: checker.method, authenticated: false }, recordedAt: r.recordedAt,
  };
}

/** Most recent check. Conflicting outcomes at the latest time have no safe decisive ordering. */
export function latestCheck(checks: CheckRecord[]): CheckRecord | null {
  if (checks.length === 0) return null;
  const latestTime = Math.max(...checks.map((c) => Date.parse(c.recordedAt)));
  const latest = checks.filter((c) => Date.parse(c.recordedAt) === latestTime);
  if (new Set(latest.map((c) => c.outcome)).size > 1) {
    throw new WikiError("damaged", "ambiguous check ordering: latest checks have equal recording times and conflicting outcomes; record a later review");
  }
  return latest.sort((a, b) => a.id.localeCompare(b.id)).at(-1) ?? null;
}
