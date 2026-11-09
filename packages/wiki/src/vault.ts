import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectContainedPath } from "./paths.ts";

export type ErrorCode = "usage" | "conflict" | "not_found" | "unsupported" | "damaged" | "unavailable";
export class WikiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CONFIG = { profile: "wiki-okf", version: 1 };
const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n# Wiki\n';
// Retain old-location rules as compatibility protection alongside current derived state.
const IGNORES = "/.wiki/tmp/\n/.wiki/locks/\n/.wiki/search/\n/.wiki/qmd.sqlite\n/.wiki/qmd.sqlite-*\n";

export interface TemporaryCleanup { path: string; retained: true; message: string }
/** Files a publication wrote. One digest for a single file, or one per path. */
export type Written = { paths: string[]; digest: string } | { paths: string[]; digests: Record<string, string> };
/** What a failed publication left on disk. The CLI failure mapper reads only this record.
 * unwritten: nothing was published; a temporary file is retained.
 * written: the files in written were published, then a later step failed; temporaryPath names a retained temporary name.
 * capture: the capture directory was reserved; written lists the files published inside it, if any. */
export type PublicationRecord =
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

function hasConfigurationIdentity(config: unknown): config is { profile: unknown; version: unknown } {
  return typeof config === "object" && config !== null && !Array.isArray(config) && "profile" in config && "version" in config;
}
function existingVault(root: string): void {
  const configPath = path.join(root, ".wiki/config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  let config: unknown;
  try { config = JSON.parse(raw); }
  catch { throw new WikiError("damaged", "Invalid JSON configuration: " + configPath); }
  if (!hasConfigurationIdentity(config)) {
    throw new WikiError("damaged", "Configuration requires profile and version: " + configPath);
  }
  if (config.profile !== CONFIG.profile || config.version !== CONFIG.version) {
    throw new WikiError("unsupported", "Unsupported profile/version at " + configPath + "; expected wiki-okf version 1; no conversion performed");
  }
}

const LAYOUT = [
  [".wiki", "directory"], [".wiki/config.json", "file"], [".wiki/types", "directory"],
  [".wiki/tmp", "directory"], [".wiki/locks", "directory"],
  ["index.md", "file"], ["log.md", "file"], [".gitignore", "file"],
] as const;

export function containedEntry(root: string, relative: string): { full: string; stat: fs.Stats | undefined } {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new WikiError("usage", inspected.problem.message);
  return inspected;
}
function entry(root: string, relative: string): fs.Stats | undefined {
  return containedEntry(root, relative).stat;
}

function initializationLayoutProblems(root: string): string[] {
  const incomplete: string[] = [];
  for (const [relative, kind] of LAYOUT) {
    const item = entry(root, relative);
    if (!item || (kind === "file" ? !item.isFile() : !item.isDirectory())) incomplete.push(relative + " (missing or not a " + kind + ")");
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
