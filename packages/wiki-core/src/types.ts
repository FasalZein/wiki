/** Schema version of every record this core writes under `.wiki/`. */
export const SCHEMA_VERSION = 1;

export const AUTHORITIES = ["intent", "derived", "personal", "record"] as const;
/**
 * Authority belongs to the note's meaning:
 * - intent: decisions and policies
 * - derived: describes cited evidence
 * - personal: owner-authored ideas, no external evidence needed
 * - record: dated historical observations or source material
 */
export type Authority = (typeof AUTHORITIES)[number];

/**
 * Status of the exact content returned by a read.
 * Only `attested` is positive, and only for checked derived or intent notes.
 * - unavailable: a binding cannot be resolved (missing repository, missing ref).
 * - invalid: evidence is missing, damaged, or has an unsupported schema version.
 * - changed: the note or a source differs from the reviewed snapshot (needs review, not "false").
 */
export type TrustStatus =
  | "unchecked"
  | "attested"
  | "changed"
  | "contradicted"
  | "unavailable"
  | "invalid"
  | "owner-authored"
  | "historical"
  | "superseded";

export type ErrorCode =
  | "usage"
  | "not_found"
  | "exists"
  | "conflict"
  | "invalid_input"
  | "unsupported"
  | "unavailable"
  | "damaged";

export class WikiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "WikiError";
    this.code = code;
  }
}

/** `sha256:<64 lowercase hex>` computed over exact bytes. */
export type Digest = `sha256:${string}`;

/** Caller-chosen identity of a write request; also the record file name. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertRequestId(id: string, what = "request id"): string {
  if (!REQUEST_ID.test(id)) {
    throw new WikiError("invalid_input", `${what} must match ${REQUEST_ID}: ${JSON.stringify(id)}`);
  }
  return id;
}

const NOTE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function assertNoteId(id: string): string {
  if (!NOTE_ID.test(id)) throw new WikiError("invalid_input", `note id must match ${NOTE_ID}: ${JSON.stringify(id)}`);
  return id;
}
