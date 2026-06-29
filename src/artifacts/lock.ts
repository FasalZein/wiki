import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertSafeSegment } from "./paths";

/** A crashed writer must not wedge the vault forever: a lockfile older than this
 *  is treated as abandoned and reclaimed. The locked section is ONLY the id
 *  allocate->write (sub-millisecond) — no qmd subprocess or other slow call runs
 *  under the lock (review follow-up P1), so this window is generous by orders of
 *  magnitude and a live holder is never mistaken for a crashed one. */
const STALE_MS = 10_000;
/** Total time to wait for a held lock before giving up (the holder is alive but
 *  slow). Bounded so a genuinely stuck peer surfaces as an error, not a hang. */
const ACQUIRE_TIMEOUT_MS = 15_000;
const POLL_MS = 10;

/** Per-project lockfile path. Lives under <vault>/.wiki/ — outside projects/, so
 *  it is never scanned by the id index or any artifact walk. */
function lockPath(vaultRoot: string, project: string): string {
  assertSafeSegment(project, "project name");
  return join(vaultRoot, ".wiki", "locks", `${project}.lock`);
}

/**
 * Serialize a project's id allocate->write critical section across processes with
 * a short-lived exclusive lockfile. The `wx` flag makes creation atomic: only one
 * writer wins. A lockfile older than {@link STALE_MS} is reclaimed so a crashed
 * holder cannot deadlock the vault. The callback always runs under the lock and
 * the lock is released on BOTH success and error paths.
 *
 * ponytail: filesystem `wx` lockfile + stale-by-mtime reclaim. Upgrade path if a
 * single machine ever isn't the boundary: a real lock service. Multi-machine is
 * explicitly out of scope (ADR-0043).
 */
export async function withProjectLock<T>(vaultRoot: string, project: string, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(vaultRoot, project);
  await mkdir(join(vaultRoot, ".wiki", "locks"), { recursive: true });
  await acquire(path);
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

async function acquire(path: string): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(path, String(Date.now()), { flag: "wx" });
      return;
    } catch (error) {
      if (!isFileExists(error)) throw error;
      await reclaimIfStale(path);
      if (Date.now() > deadline) {
        throw new Error(`could not acquire project lock (held longer than ${ACQUIRE_TIMEOUT_MS}ms): ${path}`);
      }
      await Bun.sleep(POLL_MS);
    }
  }
}

/** Remove the lockfile if it is older than the stale window — a crashed holder. */
async function reclaimIfStale(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > STALE_MS) {
      await rm(path, { force: true });
    }
  } catch {
    // Lock vanished between the failed create and the stat — the holder released
    // it. Nothing to reclaim; the next acquire attempt will win.
  }
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
