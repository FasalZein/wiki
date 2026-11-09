import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { checkVault, navigationIndexes, validateInventory } from "./lint.ts";
import { scanVault, withNote, type PendingNote, type PlannedAsset } from "./inventory.ts";
import { parseNoteText } from "./frontmatter.ts";
import { indexDestinationDiagnostics, markdownText } from "./navigation.ts";
import { loadRegistry, sortDiagnostics, typeScaffold, type Diagnostic, type Registry } from "./registry.ts";
import type { HeldLock } from "./mutation.ts";
import { causeSuffix, containedEntry, createExclusive, PublicationError, sha256, unwrittenTemporary, WikiError, type ErrorCode, type TemporaryCleanup, type Written, type WrittenFile, type WrittenFiles } from "./vault.ts";

// One module owns every vault write after init: the held lock, one validation of the prospective vault,
// the fixed effect order (primary file, then generated indexes, then the log line) and the failure record.

export class ValidationError extends WikiError {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[], message = "Proposed topic or vault validation failed") { super("usage", message); this.diagnostics = diagnostics; }
}

/** Validate the vault as it will be after the pending note publishes and return its generated index bytes.
 * A duplicate scoped title on the note is a conflict with the duplicate message; any other diagnostic,
 * including an unsafe index destination, is a ValidationError. publish runs this itself under the held lock;
 * an update dry-run or no-op calls it directly. */
export function validatePending(root: string, note: PendingNote, duplicate: string, registry: Registry = loadRegistry(root)): ReadonlyMap<string, string> {
  const validated = validateInventory(withNote(scanVault(root), note), registry);
  const indexes = navigationIndexes(validated);
  if (validated.diagnostics.some(d => d.path === note.path && d.rule === "title.duplicate")) throw new WikiError("conflict", duplicate);
  const diagnostics = [...validated.diagnostics, ...indexDestinationDiagnostics(root, indexes.keys())];
  if (diagnostics.length) throw new ValidationError(diagnostics);
  return indexes;
}
/** Index regeneration validates the current vault; diagnostics are a refusal, reported by the caller as lint output. */
function validateCurrent(root: string): { diagnostics: Diagnostic[]; indexes: ReadonlyMap<string, string> } {
  const validated = checkVault(root);
  const indexes = navigationIndexes(validated);
  const diagnostics = validated.diagnostics.length ? validated.diagnostics : sortDiagnostics(indexDestinationDiagnostics(root, indexes.keys()));
  return { diagnostics, indexes };
}

export interface LogEntry { action: string; label: string; path: string }
/** The log line of a validated note change: its action and the note's frontmatter title. */
function topicLog(change: CreateChange | ReplaceChange | CaptureChange): LogEntry {
  const action = { create: "created", replace: "updated", capture: "captured" }[change.kind];
  return { action, label: markdownText(String(parseNoteText(change.markdown).frontmatter.title)), path: change.path };
}
export interface PublishedFile { path: string; bytes: Buffer; digest: string }

/** A note change also names its conflict message for a duplicate scoped title. Its log line names the note's title. */
interface NoteChange { path: string; digest: string; duplicate: string }
export type CreateChange = NoteChange & { kind: "create"; markdown: string; registry?: Registry };
/** recheck throws when the target no longer has the expected digest; it runs immediately before the rename. */
export type ReplaceChange = NoteChange & { kind: "replace"; markdown: string; bytes: Buffer; mode: number; recheck: () => void };
/** files: retained assets first, the source note last. */
export type CaptureChange = NoteChange & { kind: "capture"; directory: string; markdown: string; assets: readonly PlannedAsset[]; files: PublishedFile[] };
export type TypeChange = { kind: "type"; path: string; bytes: string; digest: string; log: LogEntry };
export type IndexChange = { kind: "index" };
/** A described vault change. publish validates it under the held lock, then runs its effects in this fixed order:
 * primary file(s), indexes, log line. */
export type Change = CreateChange | ReplaceChange | CaptureChange | TypeChange | IndexChange;
/** A complete publication. Refusals and partial publications are thrown: WikiError or ValidationError for a
 * refusal before any effect, PublicationError (with its record) once vault bytes may have changed. */
export interface Published<W extends Written> { state: "complete"; written: W }
/** Index regeneration reports validation diagnostics as a refusal value, not an error. */
export type IndexOutcome = { state: "complete"; written: WrittenFiles; indexes: ReadonlyMap<string, string> }
  | { state: "refused"; diagnostics: Diagnostic[] };

const TOPIC_PARTIAL = "Topic published but navigation or log failed; run index to repair navigation and inspect log.md before adding any missing historical entry manually";
const REGISTRY_PARTIAL = "Registry scaffold was published but its log entry failed; inspect log.md before adding the missing entry manually";

export function publish(lock: HeldLock, change: CaptureChange): Published<WrittenFiles>;
export function publish(lock: HeldLock, change: IndexChange): IndexOutcome;
export function publish(lock: HeldLock, change: CreateChange | ReplaceChange | TypeChange): Published<WrittenFile>;
export function publish(lock: HeldLock, change: Change): Published<Written> | IndexOutcome {
  const root = lock.root;
  switch (change.kind) {
    case "create": {
      const indexes = validatePending(root, { path: change.path, markdown: change.markdown }, change.duplicate, change.registry);
      fs.mkdirSync(containedEntry(root, path.posix.dirname(change.path)).full, { recursive: true });
      createNew(root, change.path, change.markdown, "Existing topic destination: " + change.path);
      completeTopic(root, change.path, change.digest, indexes, topicLog(change));
      return { state: "complete", written: { paths: [change.path], digest: change.digest } };
    }
    case "replace": {
      const indexes = validatePending(root, { path: change.path, markdown: change.markdown }, change.duplicate);
      replaceFile(root, change.path, change.bytes, change.mode, change.recheck);
      completeTopic(root, change.path, change.digest, indexes, topicLog(change));
      return { state: "complete", written: { paths: [change.path], digest: change.digest } };
    }
    case "capture": {
      const indexes = validatePending(root, { path: change.path, markdown: change.markdown, assets: change.assets }, change.duplicate);
      return { state: "complete", written: publishCapture(root, change, indexes) };
    }
    case "type":
      createNew(root, change.path, change.bytes, "Existing registry destination: " + change.path);
      try { appendLog(root, change.log); }
      catch { throw new PublicationError("damaged", REGISTRY_PARTIAL, { state: "written", written: { paths: [change.path], digest: change.digest } }); }
      return { state: "complete", written: { paths: [change.path], digest: change.digest } };
    case "index": {
      const current = validateCurrent(root);
      if (current.diagnostics.length) return { state: "refused", diagnostics: current.diagnostics };
      return { state: "complete", written: writeIndexes(root, current.indexes), indexes: current.indexes };
    }
  }
}

/** Publish a registry type scaffold and its log line. */
export function addType(lock: HeldLock, name: string, folder: string): { path: string; digest: string } {
  const scaffold = typeScaffold(lock.root, name, folder);
  publish(lock, { kind: "type", ...scaffold, log: { action: "type-added", label: name, path: scaffold.path } });
  return { path: scaffold.path, digest: scaffold.digest };
}

function createNew(root: string, relative: string, data: string, existing: string): void {
  try { createExclusive(root, relative, data); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new WikiError("conflict", existing);
    throw error;
  }
}
function replaceFile(root: string, relative: string, bytes: Buffer, mode: number, recheck: () => void): void {
  const temporaryPath = ".wiki/tmp/" + randomUUID(), tmp = containedEntry(root, temporaryPath).full;
  let primary: unknown, renamed = false;
  try {
    // Stage privately from creation, then retain the actual target access bits, not candidate/umask defaults.
    fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(tmp, mode);
    // Last full-byte read after validation and temp preparation, immediately before rename.
    recheck();
    fs.renameSync(tmp, containedEntry(root, relative).full);
    renamed = true;
  } catch (error) { primary = error; throw error; }
  finally {
    // Rename consumes the temporary name; no post-publication cleanup can mask a write.
    try { if (!renamed) fs.rmSync(tmp, { force: true }); }
    catch (error) { throw unwrittenTemporary("Unpublished update temporary-file cleanup failed at " + temporaryPath + "; inspect and remove the retained temporary file before retrying", temporaryPath, primary, error); }
  }
}
/** Index files are rewritten in place, not by temporary file and rename. A rename would replace the file mode
 * with the temporary file's mode and would succeed over a read-only index file that an in-place write refuses,
 * so it would change observable results. */
function writeIndexes(root: string, indexes: ReadonlyMap<string, string>): WrittenFiles {
  const paths: string[] = [], digests: Record<string, string> = {};
  for (const [relative, bytes] of indexes) {
    try { fs.writeFileSync(containedEntry(root, relative).full, bytes); }
    catch (error) {
      if (!paths.length) throw error;
      throw new PublicationError("damaged", error instanceof Error ? error.message : String(error), { state: "written", written: { paths, digests } }, error, error);
    }
    paths.push(relative);
    digests[relative] = sha256(bytes);
  }
  return { paths, digests };
}
function appendLog(root: string, entry: LogEntry): void {
  const log = containedEntry(root, "log.md").full;
  const previous = fs.readFileSync(log, "utf8");
  const heading = "## " + new Date().toISOString().slice(0, 10) + "\n\n";
  const line = "**" + entry.action + "** [" + entry.label + "](" + entry.path + ")\n\n";
  fs.writeFileSync(log, heading + line + (previous.startsWith(heading) ? previous.slice(heading.length) : previous));
}
function completeTopic(root: string, relative: string, digest: string, indexes: ReadonlyMap<string, string>, log: LogEntry): void {
  try {
    for (const [file, bytes] of indexes) fs.writeFileSync(containedEntry(root, file).full, bytes);
    appendLog(root, log);
  } catch (error) { throw new PublicationError("damaged", TOPIC_PARTIAL, { state: "written", written: { paths: [relative], digest } }, error); }
}

function temporaryCleanupOf(error: unknown): TemporaryCleanup | undefined {
  if (!(error instanceof PublicationError)) return undefined;
  if (error.record.state === "unwritten") return error.record.temporaryCleanup;
  if (error.record.state === "written" && error.record.temporaryPath !== undefined) return { path: error.record.temporaryPath, retained: true, message: error.message + causeSuffix(error.cause) };
  return undefined;
}
function captureFailure(directory: string, paths: string[], digests: Record<string, string>, primary: unknown): PublicationError {
  const failure = primary instanceof PublicationError && primary.record.state === "unwritten" && primary.primary !== undefined ? primary.primary : primary;
  const code: ErrorCode = failure instanceof WikiError ? failure.code : "damaged";
  const detail = (failure instanceof Error ? failure.message : String(failure)) + (failure instanceof Error && failure.cause instanceof Error ? ": " + failure.cause.message : "");
  const temporaryCleanup = temporaryCleanupOf(primary);
  return new PublicationError(code, "Capture publication incomplete: " + detail + "; retain published files, inspect " + directory + ", the reported paths and temporary files; run index to repair navigation if a source note exists and inspect log.md before any manual historical entry; do not retry or roll back automatically",
    { state: "capture", retainedDirectory: directory, ...(paths.length ? { written: { paths: [...paths], digests: { ...digests } } } : {}), ...(temporaryCleanup ? { temporaryCleanup } : {}) }, primary);
}
function publishCapture(root: string, change: CaptureChange, indexes: ReadonlyMap<string, string>): WrittenFiles {
  const { directory } = change;
  const paths: string[] = [], digests: Record<string, string> = {};
  let reserved = false;
  try {
    fs.mkdirSync(containedEntry(root, path.posix.dirname(directory)).full, { recursive: true });
    // Reserve the selected capture directory exclusively; never reuse another capture's assets.
    fs.mkdirSync(containedEntry(root, directory).full);
    reserved = true;
    fs.mkdirSync(containedEntry(root, path.posix.dirname(change.path)).full, { recursive: true });
    for (const file of change.files) {
      try { createExclusive(root, file.path, file.bytes); }
      catch (error) {
        // A published file whose temporary name was retained still counts as written.
        if (error instanceof PublicationError && error.record.state === "written") { paths.push(file.path); digests[file.path] = file.digest; }
        throw error;
      }
      paths.push(file.path); digests[file.path] = file.digest;
    }
    completeTopic(root, change.path, change.digest, indexes, topicLog(change));
  } catch (error) {
    if (reserved) throw captureFailure(directory, paths, digests, error);
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new WikiError("conflict", "Existing capture destination; no overwrite or suffix performed");
    throw error;
  }
  return { paths, digests };
}
