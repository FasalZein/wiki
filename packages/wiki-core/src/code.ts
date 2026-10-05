import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { type RecordResult, type CodeLocator, loadObservation, recordObservation, verifyObservationBlobs } from "./sources.ts";
import { canonicalJson, createFileExclusive, isDigest, isObject, readJsonRecord, sha256, type Vault, wikiPath } from "./store.ts";
import { assertRequestId, type Digest, SCHEMA_VERSION, WikiError } from "./types.ts";

/** A configured repository resolved once to an immutable local commit. */
export type ResolvedRepo =
  | { ok: true; repo: string; path: string; ref: string; commit: string; scope: "local-commit" }
  | { ok: false; repo: string; reason: string };

function git(repoPath: string, args: string[]): Buffer {
  // Replacement refs are mutable indirections, not part of an immutable commit's identity.
  return execFileSync("git", ["--no-replace-objects", "-C", repoPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
  });
}

/** Resolve the configured local ref of `name`. Never fetches; reports unavailability instead of throwing. */
export function resolveRepo(vault: Vault, name: string): ResolvedRepo {
  const binding = vault.config.repos[name];
  if (!binding) return { ok: false, repo: name, reason: `repository ${name} is not configured in this vault` };
  if (!fs.existsSync(binding.path)) return { ok: false, repo: name, reason: `repository path ${binding.path} does not exist` };
  try {
    git(binding.path, ["rev-parse", "--git-dir"]);
  } catch {
    return { ok: false, repo: name, reason: `${binding.path} is not a Git repository` };
  }
  let commit: string;
  try {
    commit = git(binding.path, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${binding.ref}^{commit}`]).toString().trim();
  } catch {
    return { ok: false, repo: name, reason: `ref ${binding.ref} does not resolve to a commit in ${binding.path}` };
  }
  return { ok: true, repo: name, path: fs.realpathSync(binding.path), ref: binding.ref, commit, scope: "local-commit" };
}

/** Repository-relative POSIX path with no traversal. */
export function assertRepoPath(p: string): string {
  const segments = p.split("/");
  if (p.length === 0 || p.startsWith("/") || p.includes("\\") || p.includes("\0") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new WikiError("invalid_input", `code path must be a normalized repository-relative path: ${JSON.stringify(p)}`);
  }
  return p;
}

/** Bytes of `path` at an immutable commit, or null when the path is not a file there. */
export function readAtCommit(repo: Extract<ResolvedRepo, { ok: true }>, path: string): Uint8Array | null {
  assertRepoPath(path);
  const listing = git(repo.path, ["ls-tree", "-z", repo.commit, "--", path]).toString();
  // Format: "<mode> <type> <oid>\t<path>\0"
  const entry = listing.split("\0").find((line) => line.endsWith(`\t${path}`));
  if (!entry) return null;
  const [, type, oid] = (entry.split("\t")[0] ?? "").split(" ");
  if (type !== "blob" || oid === undefined) return null;
  return new Uint8Array(git(repo.path, ["cat-file", "blob", oid]));
}

interface CodeCaptureRequest {
  schema: typeof SCHEMA_VERSION;
  id: string;
  repo: string;
  repoPath: string;
  ref: string;
  commit: string;
  observedAt: string;
  files: { path: string; digest: Digest; observationId: string }[];
}

/** Capture committed files, binding the full ordered snapshot before any source effects. */
export function captureCode(vault: Vault, repoName: string, paths: string[], requestId?: string): RecordResult[] {
  if (paths.length === 0) throw new WikiError("usage", "capture code needs at least one --path");
  paths.forEach(assertRepoPath);
  if (requestId !== undefined) assertRequestId(requestId);
  const repo = resolveRepo(vault, repoName);
  if (!repo.ok) throw new WikiError("unavailable", repo.reason);
  // Read every path before writing so a missing path records nothing.
  const files = paths.map((p) => {
    const bytes = readAtCommit(repo, p);
    if (bytes === null) throw new WikiError("not_found", `${p} is not a file at ${repo.ref} (${repo.commit})`);
    return { p, bytes, digest: sha256(bytes) };
  });
  let claimed: CodeCaptureRequest = {
    schema: SCHEMA_VERSION, id: requestId ?? `capture-${randomUUID()}`,
    repo: repo.repo, repoPath: repo.path, ref: repo.ref, commit: repo.commit,
    observedAt: new Date().toISOString(),
    files: files.map((file) => ({ path: file.p, digest: file.digest, observationId: `obs-${randomUUID()}` })),
  };
  if (requestId !== undefined) {
    const claimFile = wikiPath(vault, "code-requests", `${requestId}.json`);
    if (!createFileExclusive(vault, claimFile, `${JSON.stringify(claimed, null, 2)}\n`)) {
      const prior = parseCodeRequest(readJsonRecord(claimFile), requestId);
      const identity = (r: CodeCaptureRequest) => canonicalJson({
        repo: r.repo, repoPath: r.repoPath, ref: r.ref, commit: r.commit,
        files: r.files.map((f) => ({ path: f.path, digest: f.digest })),
      });
      if (identity(prior) !== identity(claimed)) throw new WikiError("conflict", `code capture request ${requestId} already binds different inputs`);
      claimed = prior;
    }
  }
  const effects = files.map((file, i) => {
    const bound = claimed.files[i];
    if (!bound || bound.path !== file.p || bound.digest !== file.digest) throw new WikiError("damaged", "code capture request does not match its captured files");
    return { ...file, observationId: bound.observationId };
  });
  const locator = (p: string): CodeLocator => ({ kind: "code", repo: claimed.repo, repoPath: claimed.repoPath, path: p, ref: claimed.ref, commit: claimed.commit, scope: "local-commit" });
  // Validate all retained effects before adding any missing effect during an identical resume.
  for (const file of claimed.files) {
    if (!fs.existsSync(wikiPath(vault, "sources", `${file.observationId}.json`))) continue;
    const prior = loadObservation(vault, file.observationId);
    verifyObservationBlobs(vault, prior);
    if (canonicalJson(prior.locator) !== canonicalJson(locator(file.path)) || prior.original.digest !== file.digest ||
        prior.original.mediaType !== "application/octet-stream" || prior.extracted !== null) {
      throw new WikiError("damaged", `code capture effect ${file.observationId} differs from its request claim`);
    }
  }
  return effects.map(({ p, bytes, observationId }) => recordObservation(vault, {
    locator: locator(p), original: { bytes, mediaType: "application/octet-stream" }, extracted: null,
    observedAt: claimed.observedAt, requestId: observationId,
  }));
}

function parseCodeRequest(raw: Record<string, unknown>, id: string): CodeCaptureRequest {
  const bad = (field: string) => new WikiError("damaged", `code capture request ${id} is malformed: ${field}`);
  if (raw.id !== id) throw bad("id");
  if (typeof raw.repo !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.repo)) throw bad("repo");
  if (typeof raw.repoPath !== "string" || !path.isAbsolute(raw.repoPath) || raw.repoPath.includes("\0")) throw bad("repoPath");
  if (typeof raw.ref !== "string" || raw.ref === "" || raw.ref.startsWith("-") || raw.ref.includes("\0")) throw bad("ref");
  if (typeof raw.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.commit)) throw bad("commit");
  if (typeof raw.observedAt !== "string" || Number.isNaN(Date.parse(raw.observedAt))) throw bad("observedAt");
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw bad("files");
  const files = raw.files.map((f: unknown) => {
    if (!isObject(f) || typeof f.path !== "string" || !isDigest(f.digest) || typeof f.observationId !== "string") throw bad("file identity");
    try { assertRepoPath(f.path); assertRequestId(f.observationId); } catch { throw bad("file locator"); }
    return { path: f.path, digest: f.digest, observationId: f.observationId };
  });
  if (new Set(files.map((f) => f.observationId)).size !== files.length) throw bad("duplicate observation identity");
  return { schema: SCHEMA_VERSION, id, repo: raw.repo, repoPath: raw.repoPath, ref: raw.ref, commit: raw.commit, observedAt: raw.observedAt, files };
}
