/**
 * Synchronization for the write path's DETACHED keyword update (ADR-0047).
 *
 * `mintAndWrite` fires `qmd update` without awaiting it, so the fake qmd's log
 * line lands *after* the create returns. A test that reads the log immediately
 * is racing the child, not observing a missing call. These helpers wait for the
 * effect with a bounded timeout so the assertions stay exact: a genuinely
 * missing update still fails, it just fails after the timeout instead of
 * instantly.
 */

import { readFile } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 10;

/** Non-empty lines currently in the fake qmd's invocation log. */
export async function logLines(stateFile: string): Promise<string[]> {
  try {
    return (await readFile(stateFile, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Wait until the log satisfies `predicate`, then return its lines. Throws with
 * the observed log when the timeout expires, so a real regression reports what
 * qmd was actually asked to do.
 */
export async function waitForLog(
  stateFile: string,
  predicate: (lines: string[]) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await logLines(stateFile);
    if (predicate(lines)) return lines;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting on qmd log; saw:\n${lines.join("\n") || "(empty)"}`);
    }
    await Bun.sleep(POLL_MS);
  }
}

/** Wait for `count` keyword updates of `collection` to reach the log. */
export async function waitForUpdates(stateFile: string, collection: string, count = 1): Promise<string[]> {
  return waitForLog(
    stateFile,
    (lines) => lines.filter((line) => line.startsWith("update") && line.includes(`-c ${collection}`)).length >= count,
  );
}
