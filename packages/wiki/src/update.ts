import * as fs from "node:fs";
import { canonicalPathProblem } from "./paths.ts";
import { containedEntry, sha256 as digest, WikiError } from "./vault.ts";
import { parseNoteText } from "./frontmatter.ts";
import type { HeldLock } from "./mutation.ts";
import { publish, topicLog, validateProspective } from "./publication.ts";

export class UpdateConflictError extends WikiError {
  readonly path: string; readonly expected: string; readonly current: string;
  constructor(path: string, expected: string, current: string) {
    super("conflict", "Stale base at " + path + "; expected " + expected + "; current " + current + "; re-read and reconsider the candidate; do not retry automatically");
    this.path = path; this.expected = expected; this.current = current;
  }
}
export interface UpdateCandidate { bytes: Buffer; markdown: string; digest: string }
/** Nonblocking open plus descriptor check also refuses FIFOs swapped in after lstat. */
export function readUpdateCandidate(file: string): UpdateCandidate {
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("Not a regular file");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new Error("Not a regular file");
    const bytes = fs.readFileSync(fd);
    const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { bytes, markdown, digest: digest(bytes) };
  } catch { throw new WikiError("usage", "Candidate must be a readable regular file containing valid UTF-8"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const TOPIC_PATH_LENGTH = new Map([["personal", 3], ["projects", 4]]);
function validateUpdatePath(relative: string): void {
  const invalid = canonicalPathProblem(relative);
  if (invalid) throw new WikiError("usage", invalid.message);
  const parts = relative.split("/");
  if (parts.length !== TOPIC_PATH_LENGTH.get(parts[0]!) || !relative.endsWith(".md") || parts.some(p => ["assets", "index.md", "log.md"].includes(p))) throw new WikiError("usage", "Expected a canonical topic path, not navigation or operational data");
}

function captureTarget(root: string, relative: string): { bytes: Buffer; mode: number } {
  validateUpdatePath(relative);
  const target = containedEntry(root, relative);
  if (!target.stat) throw new WikiError("not_found", "Missing requested note: " + relative);
  if (!target.stat.isFile()) throw new WikiError("usage", "Expected a regular Markdown topic: " + relative);
  const fd = fs.openSync(target.full, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new WikiError("usage", "Expected a regular Markdown topic: " + relative);
    return { bytes: fs.readFileSync(fd), mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function compare(root: string, relative: string, expected: string) {
  const target = captureTarget(root, relative), current = digest(target.bytes);
  if (current !== expected) throw new UpdateConflictError(relative, expected, current);
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
export function updateTopic(root: string, relative: string, expected: string, candidate: UpdateCandidate, apply: { dryRun: true } | { dryRun: false; lock: HeldLock }) {
  const before = compare(root, relative, expected);
  const plan = validateProspective(root, { path: relative, markdown: candidate.markdown, replace: true }, "Duplicate normalized title at " + relative);
  const result = { path: relative, digest: candidate.digest, candidateDigest: candidate.digest, ...difference(before.bytes, candidate) };
  if (apply.dryRun) return { ...result, outcome: "dry-run" as const, navigation: "unchanged", log: "unchanged" };
  if (before.bytes.equals(candidate.bytes)) {
    compare(root, relative, expected);
    return { ...result, outcome: "unchanged" as const, navigation: "unchanged", log: "unchanged" };
  }
  const title = parseNoteText(candidate.markdown).frontmatter.title;
  publish(apply.lock, { kind: "replace", path: relative, bytes: candidate.bytes, digest: candidate.digest, mode: before.mode,
    recheck: () => { compare(root, relative, expected); }, plan, log: topicLog("updated", String(title), relative) });
  return { ...result, outcome: "updated" as const, written: true as const, navigation: "updated", log: "appended" };
}
