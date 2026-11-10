import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectContainedPath } from "./paths.ts";
import { isMapping } from "./frontmatter.ts";

export type ErrorCode = "usage" | "conflict" | "not_found" | "unsupported" | "damaged" | "unavailable";
export class WikiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CONFIG = { profile: "wiki-okf", version: 1 } as const;
const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n# Wiki\n';
// Retain old-location rules as compatibility protection alongside current derived state.
const IGNORES = "/.wiki/tmp/\n/.wiki/locks/\n/.wiki/search/\n/.wiki/qmd.sqlite\n/.wiki/qmd.sqlite-*\n";

export interface TemporaryCleanup { path: string; retained: true; message: string }
/** Files a publication wrote. One digest for a single file, or one per path. */
export type WrittenFile = { paths: string[]; digest: string };
export type WrittenFiles = { paths: string[]; digests: Record<string, string> };
export type Written = WrittenFile | WrittenFiles;
/** What a failed publication left on disk. The CLI failure mapper reads only this record.
 * unwritten: nothing was published; a temporary file is retained.
 * written: the files in written were published, then a later step failed; temporaryPath names a retained temporary name.
 * capture: the capture directory was reserved; written lists the files published inside it, if any. */
type PublicationRecord =
  | { state: "unwritten"; temporaryCleanup: TemporaryCleanup }
  | { state: "written"; written: Written; temporaryPath?: string }
  | { state: "capture"; retainedDirectory: string; written?: Written; temporaryCleanup?: TemporaryCleanup };
/** The one error shape for a publication that failed after it could change vault bytes.
 * The error message is the repair hint. primary, when set, is the failure to report instead of this error
 * (for example the refusal that ran before a temporary-file cleanup also failed). */
export class PublicationError extends WikiError {
  readonly record: PublicationRecord;
  readonly primary: unknown;
  constructor(code: ErrorCode, message: string, record: PublicationRecord, cause?: unknown, primary?: unknown) {
    super(code, message);
    this.record = record; this.cause = cause; this.primary = primary;
  }
}
export function sha256(data: string | Buffer): string { return "sha256:" + createHash("sha256").update(data).digest("hex"); }
export function causeSuffix(error: unknown): string { return error instanceof Error ? ": " + error.message : ""; }
/** A temporary-file cleanup failure that ran before anything was published. */
export function unwrittenTemporary(message: string, temporaryPath: string, primary: unknown, cause: unknown): PublicationError {
  return new PublicationError("damaged", message, { state: "unwritten", temporaryCleanup: { path: temporaryPath, retained: true, message: message + causeSuffix(cause) } }, cause, primary);
}

function exclusivePublicationFailure(error: unknown, relative: string): unknown {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    const conflict = new WikiError("conflict", "Existing destination: " + relative + "; " + error.message);
    conflict.cause = error;
    return conflict;
  }
  return error;
}

// Adapted from the exclusive complete-file publication of the former Node core
// package (removed in #41; see git history). No donor runtime imports.
export function createExclusive(root: string, relative: string, data: string | Buffer): void {
  const target = containedEntry(root, relative).full;
  const temporaryPath = ".wiki/tmp/" + randomUUID();
  const tmp = containedEntry(root, temporaryPath).full;
  const fd = fs.openSync(tmp, "wx");
  let published = false, primary: unknown;
  try {
    try { fs.writeFileSync(fd, data); }
    finally { fs.closeSync(fd); }
    fs.linkSync(tmp, target);
    published = true;
  } catch (error) {
    primary = exclusivePublicationFailure(error, relative);
    throw primary;
  } finally {
    try { fs.rmSync(tmp, { force: true }); }
    catch (error) {
      if (published) throw new PublicationError("damaged", "File published at " + relative + " but temporary-name cleanup failed at " + temporaryPath + "; inspect retained names, run index for navigation, and inspect log.md before any manual historical entry; do not retry publication", { state: "written", written: { paths: [relative], digest: sha256(data) }, temporaryPath }, error);
      throw unwrittenTemporary("Unpublished exclusive-file cleanup failed at " + temporaryPath + "; inspect the retained temporary file before explicit cleanup", temporaryPath, primary, error);
    }
  }
}

/** Why a parsed .wiki/config.json is not the supported profile: no profile/version identity, or another profile/version.
 * Init, open and doctor share this rule and keep their own message wording. */
type ProfileProblem = "identity" | "unsupported";
export function profileProblem(config: unknown): ProfileProblem | undefined {
  if (!isMapping(config) || !("profile" in config) || !("version" in config)) return "identity";
  return config.profile === CONFIG.profile && config.version === CONFIG.version ? undefined : "unsupported";
}
function existingVault(root: string): void {
  const configPath = path.join(root, ".wiki/config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  let config: unknown;
  try { config = JSON.parse(raw); }
  catch { throw new WikiError("damaged", "Invalid JSON configuration: " + configPath); }
  const problem = profileProblem(config);
  if (problem === "identity") throw new WikiError("damaged", "Configuration requires profile and version: " + configPath);
  if (problem === "unsupported") {
    throw new WikiError("unsupported", "Unsupported profile/version at " + configPath + "; expected wiki-okf version 1; no conversion performed");
  }
}

export type LayoutKind = "directory" | "file";
/** The one managed vault layout. Init and doctor check every entry. open marks the entries every command needs
 * before it runs: index.md is navigation that lint and index report and regenerate, and .gitignore is never read. */
export const VAULT_LAYOUT: readonly { path: string; kind: LayoutKind; open: boolean }[] = [
  { path: "", kind: "directory", open: true },
  { path: ".wiki", kind: "directory", open: true },
  { path: ".wiki/config.json", kind: "file", open: true },
  { path: ".wiki/types", kind: "directory", open: true },
  { path: ".wiki/tmp", kind: "directory", open: true },
  { path: ".wiki/locks", kind: "directory", open: true },
  { path: "index.md", kind: "file", open: false },
  { path: "log.md", kind: "file", open: true },
  { path: ".gitignore", kind: "file", open: false },
];
export function hasLayoutKind(stat: fs.Stats, kind: LayoutKind): boolean { return kind === "file" ? stat.isFile() : stat.isDirectory(); }

/** The one contained-path wrapper for commands: a refused path is a usage error. */
export function containedEntry(root: string, relative: string): { full: string; stat: fs.Stats | undefined } {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new WikiError("usage", inspected.problem.message);
  return inspected;
}
/** The same containment for search state and doctor inspection, where a refused path is reported by message
 * (or as an internal failure), not as a usage error. */
export function containedPath(root: string, relative: string): string {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new Error(inspected.problem.message);
  return inspected.full;
}
function entry(root: string, relative: string): fs.Stats | undefined {
  return containedEntry(root, relative).stat;
}

/** One revision of a note: its full bytes, the digest of exactly those bytes, and its permission bits. */
export interface NoteRevision { readonly bytes: Buffer; readonly digest: string; readonly mode: number }
/** The protected read under a contained path: no-follow and nonblocking open, then a descriptor check, so a
 * symlink or FIFO swapped in after the caller's lstat is refused without waiting for a writer. A symlink fails
 * the no-follow open with ELOOP and gets the same not-regular error as a FIFO. */
export function readRevisionAt(full: string, notRegular: () => Error): NoteRevision {
  let fd: number;
  try { fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") throw notRegular();
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw notRegular();
    const bytes = fs.readFileSync(fd);
    return { bytes, digest: sha256(bytes), mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
/** Read the current revision of a vault note. noun names the target in the not-regular message ("note" or "topic"). */
export function readNoteRevision(root: string, relative: string, noun: "note" | "topic"): NoteRevision {
  const { full, stat } = containedEntry(root, relative);
  const notRegular = () => new WikiError("usage", "Expected a regular Markdown " + noun + ": " + relative);
  if (!stat) throw new WikiError("not_found", "Missing requested note: " + relative);
  if (!stat.isFile()) throw notRegular();
  return readRevisionAt(full, notRegular);
}

/** An opened vault: a canonical root whose open layout and profile were checked once. */
export interface Vault {
  readonly root: string;
  entry(relative: string): { full: string; stat: fs.Stats | undefined };
  readNoteRevision(relative: string, noun: "note" | "topic"): NoteRevision;
}
export function openVault(dir: string): Vault {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new WikiError("not_found", "Missing vault: " + resolved);
  for (const item of VAULT_LAYOUT) {
    if (!item.open) continue;
    const stat = entry(resolved, item.path);
    if (!stat) throw new WikiError("damaged", "Missing vault entry: " + item.path);
    if (!hasLayoutKind(stat, item.kind)) throw new WikiError("damaged", "Wrong vault entry kind: " + item.path);
  }
  let config: unknown;
  try { config = JSON.parse(fs.readFileSync(path.join(resolved, ".wiki/config.json"), "utf8")); }
  catch { throw new WikiError("damaged", "Invalid JSON configuration"); }
  const problem = profileProblem(config);
  if (problem === "identity") throw new WikiError("damaged", "Invalid configuration");
  if (problem === "unsupported") throw new WikiError("unsupported", "Unsupported profile/version; no conversion performed");
  const root = fs.realpathSync(resolved);
  return {
    root,
    entry: relative => containedEntry(root, relative),
    readNoteRevision: (relative, noun) => readNoteRevision(root, relative, noun),
  };
}

function initializationLayoutProblems(root: string): string[] {
  const incomplete: string[] = [];
  for (const { path: relative, kind } of VAULT_LAYOUT) {
    const item = entry(root, relative);
    if (!item || !hasLayoutKind(item, kind)) incomplete.push(relative + " (missing or not a " + kind + ")");
  }
  return incomplete;
}
function validateExistingInitialization(root: string, wiki: fs.Stats): void {
  if (!wiki.isDirectory()) throw new WikiError("damaged", "Incomplete initialization: .wiki is not a directory at " + root);
  const config = entry(root, ".wiki/config.json");
  if (config?.isFile()) existingVault(root);
  const incomplete = initializationLayoutProblems(root);
  if (incomplete.length) throw new WikiError("damaged", "Incomplete initialization at " + root + ": " + incomplete.join(", ") + "; inspect retained files; no automatic repair or conversion performed");
}
function initializationTarget(dir: string): { root: string; existing: boolean } {
  let root = path.resolve(dir);
  const stat = entry(root, "");
  if (stat) {
    if (!stat.isDirectory()) throw new WikiError("usage", "Vault target is not a directory: " + root);
    // Resolve parent aliases (e.g. macOS /var); no managed path may itself be a symlink.
    root = fs.realpathSync(root);
    const wiki = entry(root, ".wiki");
    if (wiki) {
      validateExistingInitialization(root, wiki);
      return { root, existing: true };
    }
    if (fs.readdirSync(root).length) throw new WikiError("unsupported", "Refusing nonempty foreign vault at " + root + "; no conversion performed");
  }
  return { root, existing: false };
}
export function initVault(dir: string): { root: string } {
  const { root, existing } = initializationTarget(dir);
  if (existing) return { root };
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".wiki"));
  for (const name of ["types", "tmp", "locks"]) fs.mkdirSync(path.join(root, ".wiki", name));
  const seed = new URL("../seed/", import.meta.url);
  for (const name of fs.readdirSync(seed).sort()) {
    createExclusive(root, ".wiki/types/" + name, fs.readFileSync(new URL(name, seed), "utf8"));
  }
  createExclusive(root, "index.md", ROOT_INDEX);
  createExclusive(root, "log.md", "");
  createExclusive(root, ".gitignore", IGNORES);
  // Publish the completion marker last. An interrupted init must not be silently resumed.
  createExclusive(root, ".wiki/config.json", JSON.stringify(CONFIG, null, 2) + "\n");
  return { root: fs.realpathSync(root) };
}
