import * as fs from "node:fs";
import { canonicalPathProblem } from "./paths.ts";
import { readNoteRevision, readRevisionAt, WikiError, type NoteRevision, type Vault } from "./vault.ts";
import type { HeldLock } from "./mutation.ts";
import { publish, validatePending } from "./publication.ts";

export class UpdateConflictError extends WikiError {
  readonly path: string; readonly expected: string; readonly current: string;
  constructor(path: string, expected: string, current: string) {
    super("conflict", "Stale base at " + path + "; expected " + expected + "; current " + current + "; re-read and reconsider the candidate; do not retry automatically");
    this.path = path; this.expected = expected; this.current = current;
  }
}
interface UpdateCandidate { bytes: Buffer; markdown: string; digest: string }
/** Nonblocking open plus descriptor check also refuses FIFOs swapped in after lstat. */
export function readUpdateCandidate(file: string): UpdateCandidate {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("Not a regular file");
    const { bytes, digest } = readRevisionAt(file, () => new Error("Not a regular file"));
    const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { bytes, markdown, digest };
  } catch { throw new WikiError("usage", "Candidate must be a readable regular file containing valid UTF-8"); }
}
const TOPIC_PATH_LENGTH = new Map([["personal", 3], ["projects", 4]]);
function validateUpdatePath(relative: string): void {
  const invalid = canonicalPathProblem(relative);
  if (invalid) throw new WikiError("usage", invalid.message);
  const parts = relative.split("/");
  if (parts.length !== TOPIC_PATH_LENGTH.get(parts[0]!) || !relative.endsWith(".md") || parts.some(p => ["assets", "index.md", "log.md"].includes(p))) throw new WikiError("usage", "Expected a canonical topic path, not navigation or operational data");
}

function compare(root: string, relative: string, expected: string): NoteRevision {
  validateUpdatePath(relative);
  const target = readNoteRevision(root, relative, "topic");
  if (target.digest !== expected) throw new UpdateConflictError(relative, expected, target.digest);
  return target;
}
function difference(before: Buffer, after: UpdateCandidate) {
  // Common edge lines keep proposal output focused without normalizing retained bytes.
  const oldLines = before.toString("utf8").split("\n"), newLines = after.markdown.split("\n");
  let start = 0, oldEnd = oldLines.length, newEnd = newLines.length;
  const commonLength = Math.min(oldEnd, newEnd);
  while (start < commonLength && oldLines[start] === newLines[start]) start++;
  while (Math.min(oldEnd, newEnd) > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  return { summary: { beforeBytes: before.length, candidateBytes: after.bytes.length, removedLines: oldEnd - start, addedLines: newEnd - start },
    diff: { startLine: start + 1, removed: oldLines.slice(start, oldEnd), added: newLines.slice(start, newEnd) } };
}
/** Apply needs the held mutation lock; dry-run never acquires it or writes. */
type UpdateMode = { dryRun: true; vault: Vault } | { dryRun: false; lock: HeldLock };
/** The vault root comes only from the mode: dry-run reads the opened vault; apply validates, rechecks and
 * publishes under the locked root, so validation and publication cannot name different vaults. */
export function updateTopic(apply: UpdateMode, relative: string, expected: string, candidate: UpdateCandidate) {
  const root = apply.dryRun ? apply.vault.root : apply.lock.root;
  const before = compare(root, relative, expected);
  const duplicate = "Duplicate normalized title at " + relative;
  const result = { path: relative, digest: candidate.digest, candidateDigest: candidate.digest, ...difference(before.bytes, candidate) };
  // A dry-run or a no-op publishes nothing, so it validates here; an apply validates inside publish under the lock.
  if (apply.dryRun || before.bytes.equals(candidate.bytes)) validatePending(root, { path: relative, markdown: candidate.markdown }, duplicate);
  if (apply.dryRun) return { ...result, outcome: "dry-run" as const, navigation: "unchanged", log: "unchanged" };
  if (before.bytes.equals(candidate.bytes)) {
    compare(root, relative, expected);
    return { ...result, outcome: "unchanged" as const, navigation: "unchanged", log: "unchanged" };
  }
  publish(apply.lock, { kind: "replace", path: relative, markdown: candidate.markdown, bytes: candidate.bytes, digest: candidate.digest, mode: before.mode,
    recheck: () => { compare(root, relative, expected); }, duplicate });
  return { ...result, outcome: "updated" as const, written: true as const, navigation: "updated", log: "appended" };
}
