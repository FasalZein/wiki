import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { inspectVault, type ProspectiveNote } from "./lint.ts";
import { indexDestinationDiagnostics, markdownText } from "./navigation.ts";
import { sortDiagnostics, typeScaffold, type Diagnostic, type Registry } from "./registry.ts";
import type { HeldLock } from "./mutation.ts";
import { causeSuffix, containedEntry, createExclusive, PublicationError, sha256, unwrittenTemporary, WikiError, type ErrorCode, type TemporaryCleanup, type Written } from "./vault.ts";

// One module owns every vault write after init: the held lock, one validation of the prospective vault,
// the fixed effect order (primary file, then generated indexes, then the log line) and the failure record.

export class ValidationError extends WikiError {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[], message = "Proposed topic or vault validation failed") { super("usage", message); this.diagnostics = diagnostics; }
}
const VALIDATED = Symbol("validated indexes");
/** Generated index bytes for a vault that passed whole-vault validation. Only this module creates them. */
export interface ValidatedIndexes { readonly indexes: ReadonlyMap<string, string>; readonly [VALIDATED]: true }
function validated(indexes: ReadonlyMap<string, string>): ValidatedIndexes { return { indexes, [VALIDATED]: true }; }

/** Validate the vault as it will be after the note publishes. A duplicate scoped title is a conflict. */
export function validateProspective(root: string, note: ProspectiveNote, duplicate: string, registry?: Registry): ValidatedIndexes {
  const inventory = inspectVault(root, undefined, note, registry);
  if (inventory.diagnostics.some(d => d.path === note.path && d.rule === "title.duplicate")) throw new WikiError("conflict", duplicate);
  inventory.diagnostics.push(...indexDestinationDiagnostics(root, inventory.indexes.keys()));
  if (inventory.diagnostics.length) throw new ValidationError(inventory.diagnostics);
  return validated(inventory.indexes);
}
/** Index regeneration validates the current vault; the caller reports diagnostics as a refusal. */
export function validateCurrent(root: string): { diagnostics: Diagnostic[]; indexes: ReadonlyMap<string, string>; plan?: ValidatedIndexes } {
  const inventory = inspectVault(root);
  if (!inventory.diagnostics.length) {
    inventory.diagnostics.push(...indexDestinationDiagnostics(root, inventory.indexes.keys()));
    sortDiagnostics(inventory.diagnostics);
  }
  return { diagnostics: inventory.diagnostics, indexes: inventory.indexes, ...(inventory.diagnostics.length ? {} : { plan: validated(inventory.indexes) }) };
}

export interface LogEntry { action: string; label: string; path: string }
export const topicLog = (action: "created" | "updated" | "captured", title: string, relative: string): LogEntry => ({ action, label: markdownText(title), path: relative });
export interface PublishedFile { path: string; bytes: Buffer; digest: string }

/** A described vault change. publish runs its effects in this fixed order: primary file(s), indexes, log line. */
export type Change =
  | { kind: "create"; path: string; markdown: string; digest: string; plan: ValidatedIndexes; log: LogEntry }
  /** recheck throws when the target no longer has the expected digest; it runs immediately before the rename. */
  | { kind: "replace"; path: string; bytes: Buffer; digest: string; mode: number; recheck: () => void; plan: ValidatedIndexes; log: LogEntry }
  /** files: retained assets first, the source note last. */
  | { kind: "capture"; directory: string; files: PublishedFile[]; path: string; digest: string; plan: ValidatedIndexes; log: LogEntry }
  | { kind: "type"; path: string; bytes: string; digest: string; log: LogEntry }
  | { kind: "index"; plan: ValidatedIndexes };
/** A complete publication. Refusals and partial publications are thrown: WikiError or ValidationError for a
 * refusal before any effect, PublicationError (with its record) once vault bytes may have changed. */
export interface Published { state: "complete"; written: Written }

const TOPIC_PARTIAL = "Topic published but navigation or log failed; run index to repair navigation and inspect log.md before adding any missing historical entry manually";
const REGISTRY_PARTIAL = "Registry scaffold was published but its log entry failed; inspect log.md before adding the missing entry manually";

export function publish(lock: HeldLock, change: Change): Published {
  const root = lock.root;
  switch (change.kind) {
    case "create":
      fs.mkdirSync(containedEntry(root, path.posix.dirname(change.path)).full, { recursive: true });
      createNew(root, change.path, change.markdown, "Existing topic destination: " + change.path);
      completeTopic(root, change.path, change.digest, change.plan, change.log);
      return { state: "complete", written: { paths: [change.path], digest: change.digest } };
    case "replace":
      replaceFile(root, change.path, change.bytes, change.mode, change.recheck);
      completeTopic(root, change.path, change.digest, change.plan, change.log);
      return { state: "complete", written: { paths: [change.path], digest: change.digest } };
    case "capture": return { state: "complete", written: publishCapture(root, change) };
    case "type":
      createNew(root, change.path, change.bytes, "Existing registry destination: " + change.path);
      try { appendLog(root, change.log); }
      catch { throw new PublicationError("damaged", REGISTRY_PARTIAL, { state: "written", written: { paths: [change.path], digest: change.digest } }); }
      return { state: "complete", written: { paths: [change.path], digest: change.digest } };
    case "index": return { state: "complete", written: writeIndexes(root, change.plan) };
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
function writeIndexes(root: string, plan: ValidatedIndexes): Written & { digests: Record<string, string> } {
  const paths: string[] = [], digests: Record<string, string> = {};
  for (const [relative, bytes] of plan.indexes) {
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
function completeTopic(root: string, relative: string, digest: string, plan: ValidatedIndexes, log: LogEntry): void {
  try {
    for (const [file, bytes] of plan.indexes) fs.writeFileSync(containedEntry(root, file).full, bytes);
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
function publishCapture(root: string, change: Extract<Change, { kind: "capture" }>): Written {
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
    completeTopic(root, change.path, change.digest, change.plan, change.log);
  } catch (error) {
    if (reserved) throw captureFailure(directory, paths, digests, error);
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new WikiError("conflict", "Existing capture destination; no overwrite or suffix performed");
    throw error;
  }
  return { paths, digests };
}
