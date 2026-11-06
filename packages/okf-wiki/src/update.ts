import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { canonicalPathProblem } from "./paths.ts";
import { containedEntry, WikiError } from "./vault.ts";
import { inspectVault } from "./lint.ts";
import { indexDestinationDiagnostics } from "./navigation.ts";
import { completeTopicPublication, CreateValidationError } from "./create.ts";
import { parseNoteText } from "./frontmatter.ts";

function digest(bytes: Buffer): string { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }
export class UpdateConflictError extends WikiError {
  readonly path: string; readonly expected: string; readonly current: string;
  constructor(path: string, expected: string, current: string) {
    super("conflict", "Stale base at " + path + "; expected " + expected + "; current " + current + "; re-read and reconsider the candidate; do not retry automatically");
    this.path = path; this.expected = expected; this.current = current;
  }
}
export class UpdateTemporaryError extends WikiError {
  readonly temporaryPath: string; readonly primary: unknown;
  constructor(temporaryPath: string, primary: unknown, cause: unknown) {
    super("damaged", "Unpublished update temporary-file cleanup failed at " + temporaryPath + "; inspect and remove the retained temporary file before retrying");
    this.temporaryPath = temporaryPath; this.primary = primary; this.cause = cause;
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
function targetBytes(root: string, relative: string): Buffer {
  const invalid = canonicalPathProblem(relative);
  if (invalid) throw new WikiError("usage", invalid.message);
  const parts = relative.split("/");
  if (!(parts[0] === "personal" && parts.length === 3 || parts[0] === "projects" && parts.length === 4) || !relative.endsWith(".md") || parts.some(p => ["assets", "index.md", "log.md"].includes(p))) throw new WikiError("usage", "Expected a canonical topic path, not navigation or operational data");
  const target = containedEntry(root, relative);
  if (!target.stat) throw new WikiError("not_found", "Missing requested note: " + relative);
  if (!target.stat.isFile()) throw new WikiError("usage", "Expected a regular Markdown topic: " + relative);
  const fd = fs.openSync(target.full, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new WikiError("usage", "Expected a regular Markdown topic: " + relative);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function compare(root: string, relative: string, expected: string): Buffer {
  const bytes = targetBytes(root, relative), current = digest(bytes);
  if (current !== expected) throw new UpdateConflictError(relative, expected, current);
  return bytes;
}
function difference(before: Buffer, after: UpdateCandidate) {
  // Common edge lines keep proposal output focused without normalizing retained bytes.
  const oldLines = before.toString("utf8").split("\n"), newLines = after.markdown.split("\n");
  let start = 0, oldEnd = oldLines.length, newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  return { summary: { beforeBytes: before.length, candidateBytes: after.bytes.length, removedLines: oldEnd - start, addedLines: newEnd - start },
    diff: { startLine: start + 1, removed: oldLines.slice(start, oldEnd), added: newLines.slice(start, newEnd) } };
}
/** Apply caller holds the mutation lock; dry-run never acquires it or writes. */
export function updateTopic(root: string, relative: string, expected: string, candidate: UpdateCandidate, dryRun: boolean) {
  const before = compare(root, relative, expected);
  const inventory = inspectVault(root, undefined, { path: relative, markdown: candidate.markdown, replace: true });
  if (inventory.diagnostics.some(d => d.path === relative && d.rule === "title.duplicate")) throw new WikiError("conflict", "Duplicate normalized title at " + relative);
  inventory.diagnostics.push(...indexDestinationDiagnostics(root, inventory.indexes.keys()));
  if (inventory.diagnostics.length) throw new CreateValidationError(inventory.diagnostics);
  const result = { path: relative, digest: candidate.digest, candidateDigest: candidate.digest, ...difference(before, candidate) };
  if (dryRun) return { ...result, outcome: "dry-run" as const, navigation: "unchanged", log: "unchanged" };
  if (before.equals(candidate.bytes)) {
    compare(root, relative, expected);
    return { ...result, outcome: "unchanged" as const, navigation: "unchanged", log: "unchanged" };
  }
  const title = parseNoteText(candidate.markdown).frontmatter.title;
  const temporaryPath = ".wiki/tmp/" + randomUUID(), tmp = containedEntry(root, temporaryPath).full;
  let primary: unknown, renamed = false;
  try {
    fs.writeFileSync(tmp, candidate.bytes, { flag: "wx" });
    // Last full-byte read after validation and temp preparation, immediately before rename.
    compare(root, relative, expected);
    fs.renameSync(tmp, containedEntry(root, relative).full);
    renamed = true;
  } catch (error) { primary = error; throw error; }
  finally {
    // Rename consumes the temporary name; no post-publication cleanup can mask a write.
    try { if (!renamed) fs.rmSync(tmp, { force: true }); }
    catch (error) { throw new UpdateTemporaryError(temporaryPath, primary, error); }
  }
  completeTopicPublication(root, relative, String(title), candidate.digest, inventory.indexes, "updated");
  return { ...result, outcome: "updated" as const, written: true as const, navigation: "updated", log: "appended" };
}
