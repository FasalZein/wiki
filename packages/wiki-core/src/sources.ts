import { assertRepoPath } from "./code.ts";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalJson,
  createFileExclusive,
  getBlob,
  isDigest,
  isObject,
  putBlob,
  readJsonRecord,
  type Vault,
  wikiPath,
} from "./store.ts";
import { loadNote } from "./notes.ts";
import { assertNoteId, assertRequestId, type Digest, SCHEMA_VERSION, WikiError } from "./types.ts";

/**
 * Source capture contract shared by all adapters (text, code, web, PDF).
 *
 * An adapter obtains bytes at its boundary, extracts text (or reports that it cannot),
 * then calls `recordObservation`. The core retains the original bytes and extracted text
 * as content-addressed blobs and writes one immutable observation record.
 * Identical bytes are stored once; every observation keeps its own provenance.
 */

export interface Extractor {
  /** Stable extractor name, e.g. `utf8-text`, `pdftotext`, `pandoc`. */
  name: string;
  /** Extractor version string as observed at capture time. */
  version: string;
  /** Decoder label when original bytes were decoded before extraction. */
  charset?: string;
  /**
   * Explicit gaps in the extracted text.
   * Absent when the extractor represented the whole document.
   */
  limitations?: readonly string[];
}

export interface TextLocator {
  kind: "text";
  /** Absolute real path of the imported file at import time. */
  path: string;
}

export interface CodeLocator {
  kind: "code";
  repo: string;
  /** Canonical local repository path at capture time; part of the evidence binding. */
  repoPath: string;
  /** Repository-relative POSIX path. */
  path: string;
  /** Configured local ref, resolved once per capture. */
  ref: string;
  commit: string;
  /** Code evidence never includes uncommitted or unfetched changes. */
  scope: "local-commit";
}

export interface WebLocator {
  kind: "web";
  url: string;
  /** URL after redirects, when it differs from `url`. */
  finalUrl: string | null;
  httpStatus: number;
}

export interface DocumentLocator {
  kind: "pdf";
  /** Absolute real path of the imported file at import time. */
  path: string;
}

export interface NoteLocator {
  kind: "note";
  /** Stable identity in this vault, independent of file name. */
  noteId: string;
  /** Exact Markdown file bytes that were captured, not a later revision. */
  noteDigest: Digest;
}

export type SourceLocator = TextLocator | CodeLocator | WebLocator | DocumentLocator | NoteLocator;
export type SourceKind = SourceLocator["kind"];
const SOURCE_KINDS: readonly SourceKind[] = ["text", "code", "web", "pdf", "note"];

export interface ObservationInput {
  locator: SourceLocator;
  original: { bytes: Uint8Array; mediaType: string };
  /** Extracted text, or null when the source has no separate text form. Never invented. */
  extracted: { text: string; extractor: Extractor } | null;
  /** When the bytes were obtained (retrieval time for web). Defaults to now. */
  observedAt?: string;
  /** Caller request identity; replaying the same id with the same content is a no-op. */
  requestId?: string;
}

export interface BlobRef {
  digest: Digest;
  size: number;
}

export interface SourceObservation {
  schema: typeof SCHEMA_VERSION;
  id: string;
  locator: SourceLocator;
  observedAt: string;
  original: BlobRef & { mediaType: string };
  extracted: (BlobRef & { extractor: Extractor }) | null;
}

export interface RecordResult {
  observation: SourceObservation;
  /** True when this exact request was already recorded; nothing was written. */
  replayed: boolean;
}

function observationFile(vault: Vault, id: string): string {
  return wikiPath(vault, "sources", `${assertRequestId(id, "observation id")}.json`);
}

/** The digest a check binds to: extracted text when present, else original bytes. */
export function evidenceDigest(observation: SourceObservation): Digest {
  return observation.extracted?.digest ?? observation.original.digest;
}

export function recordObservation(vault: Vault, input: ObservationInput): RecordResult {
  const id = input.requestId === undefined ? `obs-${randomUUID()}` : assertRequestId(input.requestId);
  const originalDigest = putBlob(vault, input.original.bytes);
  let extracted: SourceObservation["extracted"] = null;
  if (input.extracted) {
    const bytes = new TextEncoder().encode(input.extracted.text);
    extracted = { digest: putBlob(vault, bytes), size: bytes.byteLength, extractor: input.extracted.extractor };
  }
  const observation: SourceObservation = {
    schema: SCHEMA_VERSION,
    id,
    locator: input.locator,
    observedAt: input.observedAt ?? new Date().toISOString(),
    original: { digest: originalDigest, size: input.original.bytes.byteLength, mediaType: input.original.mediaType },
    extracted,
  };
  parseObservation(observation, id);
  const file = observationFile(vault, id);
  if (createFileExclusive(vault, file, `${JSON.stringify(observation, null, 2)}\n`)) {
    return { observation, replayed: false };
  }
  const existing = loadObservation(vault, id);
  // Replay identity covers what was observed, not when the replay ran.
  const same = (o: SourceObservation) => canonicalJson({ ...o, observedAt: null });
  if (same(existing) !== same(observation)) {
    throw new WikiError("conflict", `observation id ${id} already records different source content or provenance`);
  }
  return { observation: existing, replayed: true };
}

/** Load and validate an observation record. Missing, malformed, or unsupported records fail closed. */
export function loadObservation(vault: Vault, id: string): SourceObservation {
  const file = observationFile(vault, id);
  if (!fs.existsSync(file)) throw new WikiError("damaged", `source observation ${id} is missing`);
  return parseObservation(readJsonRecord(file), id);
}

function parseObservation(value: unknown, id: string): SourceObservation {
  const bad = (why: string) => new WikiError("damaged", `source observation ${id} is malformed: ${why}`);
  if (!isObject(value)) throw bad("record");
  const r = value;
  if (r.id !== id) throw bad("id does not match file name");
  if (typeof r.observedAt !== "string" || Number.isNaN(Date.parse(r.observedAt))) throw bad("observedAt");
  const loc = r.locator;
  if (!isObject(loc) || !SOURCE_KINDS.includes(loc.kind as SourceKind)) throw bad("locator");
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "") throw bad(field);
    return value;
  };
  const absolutePath = (value: unknown, field: string): string => {
    const p = text(value, field);
    if (!path.isAbsolute(p) || p.includes("\0")) throw bad(field);
    return p;
  };
  const httpUrl = (value: unknown): string => {
    const raw = text(value, "web URL");
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return raw;
    } catch { /* Invalid retained locator. */ }
    throw bad("web URL");
  };
  let locator: SourceLocator;
  switch (loc.kind) {
    case "text": locator = { kind: "text", path: absolutePath(loc.path, "text path") }; break;
    case "pdf": locator = { kind: "pdf", path: absolutePath(loc.path, "PDF path") }; break;
    case "code": {
      const repo = text(loc.repo, "repository key");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(repo)) throw bad("repository key");
      const sourcePath = text(loc.path, "code path");
      try { assertRepoPath(sourcePath); } catch { throw bad("code path"); }
      const ref = text(loc.ref, "code ref");
      if (ref.startsWith("-") || ref.includes("\0")) throw bad("code ref");
      const commit = text(loc.commit, "code commit");
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) || loc.scope !== "local-commit") throw bad("code commit or scope");
      locator = { kind: "code", repo, repoPath: absolutePath(loc.repoPath, "repository binding path"), path: sourcePath, ref, commit, scope: "local-commit" };
      break;
    }
    case "note": {
      const noteId = text(loc.noteId, "referenced note id");
      try { assertNoteId(noteId); } catch { throw bad("referenced note id"); }
      if (!isDigest(loc.noteDigest)) throw bad("referenced note digest");
      locator = { kind: "note", noteId, noteDigest: loc.noteDigest };
      break;
    }
    case "web": {
      if (typeof loc.httpStatus !== "number" || !Number.isInteger(loc.httpStatus) || loc.httpStatus < 200 || loc.httpStatus > 299) throw bad("HTTP status");
      locator = { kind: "web", url: httpUrl(loc.url), finalUrl: loc.finalUrl === null ? null : httpUrl(loc.finalUrl), httpStatus: loc.httpStatus };
      break;
    }
    default: throw bad("locator kind");
  }
  const blob = (value: unknown): BlobRef => {
    if (!isObject(value) || !isDigest(value.digest) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) throw bad("blob identity or size");
    return { digest: value.digest, size: value.size };
  };
  const orig = r.original;
  if (!isObject(orig)) throw bad("original");
  const original = { ...blob(orig), mediaType: text(orig.mediaType, "media type") };
  let extracted: SourceObservation["extracted"] = null;
  if (r.extracted !== null) {
    const ext = r.extracted;
    if (!isObject(ext) || !isObject(ext.extractor)) throw bad("extracted provenance");
    const ex = ext.extractor;
    const extractor: Extractor = { name: text(ex.name, "extractor name"), version: text(ex.version, "extractor version") };
    if (ex.charset !== undefined) extractor.charset = text(ex.charset, "extractor charset");
    if (ex.limitations !== undefined) {
      if (!Array.isArray(ex.limitations) || !ex.limitations.every((v: unknown) => typeof v === "string" && v.trim() !== "")) throw bad("extractor limitations");
      extractor.limitations = ex.limitations;
    }
    extracted = { ...blob(ext), extractor };
  }
  if (locator.kind === "note" && (locator.noteDigest !== original.digest || extracted !== null)) throw bad("referenced note snapshot identity");
  return { schema: SCHEMA_VERSION, id, locator, observedAt: r.observedAt, original, extracted };
}

/** Verify that every retained blob of an observation is present and intact. */
export function verifyObservationBlobs(vault: Vault, observation: SourceObservation): void {
  const verify = (ref: BlobRef): void => {
    if (getBlob(vault, ref.digest).byteLength !== ref.size) throw new WikiError("damaged", `retained snapshot ${ref.digest} has the wrong byte count`);
  };
  verify(observation.original);
  if (observation.extracted) verify(observation.extracted);
}

/** Text the observation retains for reading: extracted text, else UTF-8 original. */
export function observationText(vault: Vault, observation: SourceObservation): string {
  return new TextDecoder().decode(getBlob(vault, evidenceDigest(observation)));
}

/**
 * Resolve an import path at the trust boundary: it must name an existing regular file.
 * Symlinks are resolved so provenance records the real file.
 */
export function resolveImportFile(file: string): string {
  const abs = path.resolve(file);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new WikiError("not_found", `import file does not exist: ${abs}`);
  }
  if (!fs.statSync(real).isFile()) throw new WikiError("invalid_input", `import path is not a regular file: ${real}`);
  return real;
}

const TEXT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".text": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

export const SUPPORTED_TEXT_EXTENSIONS = Object.keys(TEXT_TYPES);

/**
 * Import a UTF-8 text document. Other formats are refused with an explicit limitation;
 * format adapters (PDF and others) call `recordObservation` with their own extraction.
 */
export function importTextFile(vault: Vault, file: string, requestId?: string): RecordResult {
  const real = resolveImportFile(file);
  const ext = path.extname(real).toLowerCase();
  const mediaType = TEXT_TYPES[ext];
  if (mediaType === undefined) {
    throw new WikiError(
      "unsupported",
      `text import supports ${SUPPORTED_TEXT_EXTENSIONS.join(", ")}; no extractor for ${ext || "files without extension"} (${real})`,
    );
  }
  const bytes = fs.readFileSync(real);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WikiError("unsupported", `file is not valid UTF-8 text; refusing to invent its contents: ${real}`);
  }
  return recordObservation(vault, {
    locator: { kind: "text", path: real },
    original: { bytes, mediaType },
    extracted: { text, extractor: { name: "utf8-text", version: "1" } },
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/** Capture a note in this vault as immutable source bytes without inheriting its trust status. */
export function captureNote(vault: Vault, noteId: string, requestId?: string): RecordResult {
  const note = loadNote(vault, noteId);
  return recordObservation(vault, {
    locator: { kind: "note", noteId: note.id, noteDigest: note.digest },
    original: { bytes: note.bytes, mediaType: "text/markdown" },
    extracted: null,
    ...(requestId === undefined ? {} : { requestId }),
  });
}
