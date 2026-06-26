import { access } from "node:fs/promises";
import { homedir } from "node:os";

/** True when an error is a filesystem "no such file or directory" (ENOENT). */
export function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Narrow an unknown to a plain object record (excludes null and arrays). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The user's home directory. Reads $HOME live (so a test or caller that sets
 *  process.env.HOME is honored), falling back to node:os homedir when unset. */
export function homeDir(): string {
  const home = process.env.HOME;
  return home !== undefined && home.length > 0 ? home : homedir();
}

/** Expand a leading `~` or `~/` to the OS home directory; pass through otherwise. */
export function expandHome(path: string): string {
  if (path === "~") {
    return homeDir();
  }
  if (path.startsWith("~/")) {
    return `${homeDir()}${path.slice(1)}`;
  }
  return path;
}

/** True when a path is accessible (file or directory exists). */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
