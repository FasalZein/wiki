import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Digest, SCHEMA_VERSION, WikiError } from "./types.ts";

export interface RepoBinding {
  /** Absolute path of a local Git repository. */
  path: string;
  /** Local ref that code evidence is compared against, e.g. `main`. */
  ref: string;
}

export interface VaultConfig {
  schema: typeof SCHEMA_VERSION;
  repos: Record<string, RepoBinding>;
}

export interface Vault {
  root: string;
  config: VaultConfig;
}

const WIKI_DIR = ".wiki";
const CONFIG_FILE = "vault.json";

export function wikiPath(vault: Vault | string, ...parts: string[]): string {
  const root = typeof vault === "string" ? vault : vault.root;
  return path.join(root, WIKI_DIR, ...parts);
}

export function sha256(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Create a new disposable vault. Re-running on an existing vault returns it unchanged. */
export function initVault(dir: string): Vault {
  const root = path.resolve(dir);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(wikiPath(root), { recursive: true });
  const configPath = wikiPath(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    const config: VaultConfig = { schema: SCHEMA_VERSION, repos: {} };
    writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    // Evidence under .wiki is Git-tracked; only scratch files are excluded.
    fs.writeFileSync(wikiPath(root, ".gitignore"), "tmp/\n", { flag: "wx" });
  }
  return openVault(root);
}

export function openVault(dir: string): Vault {
  const root = path.resolve(dir);
  const configPath = wikiPath(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new WikiError("not_found", `no wiki vault at ${root} (missing ${path.join(WIKI_DIR, CONFIG_FILE)}); run init`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WikiError("damaged", `vault config is not valid JSON: ${configPath}`);
  }
  if (!isObject(parsed)) throw new WikiError("damaged", `vault config is not an object: ${configPath}`);
  if (parsed.schema !== SCHEMA_VERSION) {
    throw new WikiError("unsupported", `unsupported vault schema ${JSON.stringify(parsed.schema)}; this build reads ${SCHEMA_VERSION}`);
  }
  const repos: Record<string, RepoBinding> = {};
  if (!isObject(parsed.repos)) throw new WikiError("damaged", `vault config repos is not an object: ${configPath}`);
  for (const [name, value] of Object.entries(parsed.repos)) {
    if (!isObject(value) || typeof value.path !== "string" || typeof value.ref !== "string") {
      throw new WikiError("damaged", `vault config repo ${JSON.stringify(name)} is malformed`);
    }
    repos[name] = { path: value.path, ref: value.ref };
  }
  return { root, config: { schema: SCHEMA_VERSION, repos } };
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function setRepo(vault: Vault, name: string, repoPath: string, ref: string): Vault {
  if (!REPO_NAME.test(name)) throw new WikiError("invalid_input", `repo name must match ${REPO_NAME}`);
  if (!path.isAbsolute(repoPath)) throw new WikiError("invalid_input", `repo path must be absolute: ${repoPath}`);
  if (ref.length === 0 || ref.startsWith("-")) throw new WikiError("invalid_input", `invalid ref: ${JSON.stringify(ref)}`);
  const config: VaultConfig = { ...vault.config, repos: { ...vault.config.repos, [name]: { path: repoPath, ref } } };
  writeFileAtomic(wikiPath(vault, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  return { root: vault.root, config };
}

function tmpPath(vault: string): string {
  const dir = path.join(vault, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${process.pid}-${randomUUID()}`);
}

/** Replace a file by rename. Used only for files the CLI owns (vault config). */
function writeFileAtomic(target: string, data: string): void {
  const tmp = tmpPath(path.dirname(target));
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

/**
 * Create `target` with complete contents, failing if it exists.
 * A hard link from a fully written temp file never exposes a partial record and never overwrites.
 * Returns false when the target already exists.
 */
export function createFileExclusive(vault: Vault, target: string, data: Uint8Array | string): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tmpPath(wikiPath(vault));
  fs.writeFileSync(tmp, data);
  try {
    fs.linkSync(tmp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function blobPath(vault: Vault, digest: Digest): string {
  const hex = digest.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new WikiError("invalid_input", `malformed digest: ${digest}`);
  return wikiPath(vault, "objects", "sha256", hex.slice(0, 2), hex);
}

/** Store immutable bytes by content digest. Identical bytes are stored once. */
export function putBlob(vault: Vault, bytes: Uint8Array): Digest {
  const digest = sha256(bytes);
  const target = blobPath(vault, digest);
  if (!fs.existsSync(target)) createFileExclusive(vault, target, bytes);
  return digest;
}

/** Read retained bytes and verify them. Missing or damaged blobs fail closed. */
export function getBlob(vault: Vault, digest: Digest): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(blobPath(vault, digest));
  } catch {
    throw new WikiError("damaged", `retained snapshot ${digest} is missing`);
  }
  if (sha256(bytes) !== digest) throw new WikiError("damaged", `retained snapshot ${digest} is damaged (digest mismatch)`);
  return bytes;
}

export function hasBlob(vault: Vault, digest: Digest): boolean {
  return fs.existsSync(blobPath(vault, digest));
}

/** Parse a JSON record file. Malformed or truncated content throws `damaged`. */
export function readJsonRecord(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new WikiError("damaged", `record is missing: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WikiError("damaged", `record is not valid JSON (truncated or corrupted): ${file}`);
  }
  if (!isObject(parsed)) throw new WikiError("damaged", `record is not an object: ${file}`);
  if (parsed.schema !== SCHEMA_VERSION) {
    throw new WikiError("unsupported", `record has unsupported schema ${JSON.stringify(parsed.schema)}: ${file}`);
  }
  return parsed;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Stable JSON for replay comparison: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}
