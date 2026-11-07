import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { containedEntry, WikiError } from "./vault.ts";

export class MutationReleaseError extends Error {
  readonly outcome: { kind: "completed" } | { kind: "failed"; error: unknown };
  constructor(outcome: MutationReleaseError["outcome"], cause: unknown) {
    super("Mutation lock release failed; .wiki/locks/mutation.lock is retained; inspect ownership before explicit recovery", { cause });
    this.outcome = outcome;
  }
}

function acquireMutationLock(root: string) {
  const directory = containedEntry(root, ".wiki/locks");
  if (!directory.stat?.isDirectory()) throw new WikiError("damaged", "Missing .wiki/locks directory");
  const full = directory.full + "/mutation.lock";
  const token = randomUUID();
  let fd: number;
  try { fd = fs.openSync(full, "wx", 0o600); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new WikiError("conflict", "Vault mutation lock busy: .wiki/locks/mutation.lock; inspect its owner before explicit operator recovery; never reclaimed automatically");
    throw error;
  }
  return { fd, full, token, owned: fs.fstatSync(fd) };
}
function ownsMutationToken(full: string, token: string): boolean {
  let owner: unknown;
  try { owner = JSON.parse(fs.readFileSync(full, "utf8")); } catch { /* Retain damaged ownership records for operator inspection. */ }
  return typeof owner === "object" && owner !== null && "token" in owner && owner.token === token;
}
function releaseMutationLock(fd: number, full: string, owned: fs.Stats, token: string): void {
  fs.closeSync(fd);
  // A replaced lock belongs to another owner, even if this process created the old one.
  const current = fs.lstatSync(full, { throwIfNoEntry: false });
  if (current?.isFile() && current.dev === owned.dev && current.ino === owned.ino && ownsMutationToken(full, token)) fs.unlinkSync(full);
}
/** Single-host, non-stealing coordination for cooperating CLI writers only. */
export function withMutationLock<T>(root: string, action: () => T): T {
  const { fd, full, token, owned } = acquireMutationLock(root);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), started: new Date().toISOString() }) + "\n");
    outcome = { ok: true, value: action() };
  } catch (error) { outcome = { ok: false, error }; }
  try { releaseMutationLock(fd, full, owned, token); }
  catch (error) {
    throw new MutationReleaseError(outcome.ok ? { kind: "completed" } : { kind: "failed", error: outcome.error }, error);
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
