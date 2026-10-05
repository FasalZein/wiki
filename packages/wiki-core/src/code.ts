import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { type RecordResult, recordObservation } from "./sources.ts";
import type { Vault } from "./store.ts";
import { assertRequestId, WikiError } from "./types.ts";

/** A configured repository resolved once to an immutable local commit. */
export type ResolvedRepo =
  | { ok: true; repo: string; path: string; ref: string; commit: string; scope: "local-commit" }
  | { ok: false; repo: string; reason: string };

function git(repoPath: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repoPath, ...args], {
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

/**
 * Capture committed code files. The ref resolves once; every path is read from that commit.
 * With a request id, observation ids are `<requestId>.<index>` in path order.
 */
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
    return { p, bytes };
  });
  return files.map(({ p, bytes }, i) => {
    return recordObservation(vault, {
      locator: { kind: "code", repo: repo.repo, repoPath: repo.path, path: p, ref: repo.ref, commit: repo.commit, scope: "local-commit" },
      original: { bytes, mediaType: "application/octet-stream" },
      extracted: null,
      ...(requestId === undefined ? {} : { requestId: `${requestId}.${i}` }),
    });
  });
}
