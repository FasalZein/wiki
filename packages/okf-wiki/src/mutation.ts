import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { containedEntry, WikiError } from "./vault.ts";

/** Single-host, non-stealing coordination for cooperating CLI writers only. */
export function withMutationLock<T>(root: string, action: () => T): T {
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
  const owned = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), started: new Date().toISOString() }) + "\n");
    return action();
  } finally {
    fs.closeSync(fd);
    // A replaced lock belongs to another owner, even if this process created the old one.
    const current = fs.lstatSync(full, { throwIfNoEntry: false });
    if (current?.isFile() && current.dev === owned.dev && current.ino === owned.ino) {
      let owner: unknown;
      try { owner = JSON.parse(fs.readFileSync(full, "utf8")); } catch { /* Retain damaged ownership records for operator inspection. */ }
      if (typeof owner === "object" && owner !== null && "token" in owner && owner.token === token) fs.unlinkSync(full);
    }
  }
}
