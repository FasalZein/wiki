import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectContainedPath } from "./paths.ts";

export type ErrorCode = "usage" | "conflict" | "not_found" | "unsupported" | "damaged";
export class WikiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CONFIG = { profile: "wiki-okf", version: 1 };
const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n# Wiki\n';
const IGNORES = "/.wiki/tmp/\n/.wiki/locks/\n/.wiki/qmd.sqlite\n/.wiki/qmd.sqlite-*\n";

export class ExclusiveCleanupError extends WikiError {
  readonly written = true;
  readonly paths: string[];
  readonly digest: string;
  readonly temporaryPath: string;
  constructor(relative: string, data: string, temporaryPath: string, cause: unknown) {
    super("damaged", "File published at " + relative + " but temporary-name cleanup failed at " + temporaryPath + "; inspect retained names, run index for navigation, and inspect log.md before any manual historical entry; do not retry publication");
    this.paths = [relative];
    this.digest = "sha256:" + createHash("sha256").update(data).digest("hex");
    this.temporaryPath = temporaryPath;
    this.cause = cause;
  }
}

// Adapted from wiki-core's exclusive complete-file publication. No donor runtime imports.
export function createExclusive(root: string, relative: string, data: string): void {
  const target = containedEntry(root, relative).full;
  const temporaryPath = ".wiki/tmp/" + randomUUID();
  const tmp = containedEntry(root, temporaryPath).full;
  fs.writeFileSync(tmp, data, { flag: "wx" });
  let published = false;
  try {
    fs.linkSync(tmp, target);
    published = true;
  } finally {
    try { fs.rmSync(tmp, { force: true }); }
    catch (error) {
      if (published) throw new ExclusiveCleanupError(relative, data, temporaryPath, error);
      // Keep the primary publication failure (for example EEXIST), not a later cleanup error.
    }
  }
}

function existingVault(root: string): void {
  const configPath = path.join(root, ".wiki/config.json");
  const raw = fs.readFileSync(configPath, "utf8");
  let config: unknown;
  try { config = JSON.parse(raw); }
  catch { throw new WikiError("damaged", "Invalid JSON configuration: " + configPath); }
  if (typeof config !== "object" || config === null || Array.isArray(config) || !("profile" in config) || !("version" in config)) {
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

export function initVault(dir: string): { root: string } {
  let root = path.resolve(dir);
  const stat = entry(root, "");
  if (stat) {
    if (!stat.isDirectory()) throw new WikiError("usage", "Vault target is not a directory: " + root);
    // Resolve parent aliases (e.g. macOS /var); no managed path may itself be a symlink.
    root = fs.realpathSync(root);
    const wiki = entry(root, ".wiki");
    if (wiki) {
      if (!wiki.isDirectory()) throw new WikiError("damaged", "Incomplete initialization: .wiki is not a directory at " + root);
      const config = entry(root, ".wiki/config.json");
      if (config?.isFile()) existingVault(root);
      const incomplete: string[] = [];
      for (const [relative, kind] of LAYOUT) {
        const item = entry(root, relative);
        if (!item || (kind === "file" ? !item.isFile() : !item.isDirectory())) incomplete.push(relative + " (missing or not a " + kind + ")");
      }
      if (incomplete.length) throw new WikiError("damaged", "Incomplete initialization at " + root + ": " + incomplete.join(", ") + "; inspect retained files; no automatic repair or conversion performed");
      return { root };
    }
    if (fs.readdirSync(root).length) throw new WikiError("unsupported", "Refusing nonempty foreign vault at " + root + "; no conversion performed");
  }
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
