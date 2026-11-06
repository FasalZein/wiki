import * as fs from "node:fs";
import * as path from "node:path";

export type PathProblem = { rule: "path.invalid" | "path.symlink" | "path.kind"; message: string };
function invalidShape(relative: string): boolean {
  return !relative || relative.includes("\\") || relative.includes("\0") || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split("/").some(p => !p || p === "." || p === "..");
}
export function canonicalPathProblem(relative: string): PathProblem | undefined {
  if (invalidShape(relative)) {
    return { rule: "path.invalid", message: "Expected a vault-relative canonical path without absolute, empty, backslash, NUL, or dot segments" };
  }
  // Canonical paths name literal files, not URL aliases. Also reject encoded unsafe components.
  // A literal percent in a retained filename is valid and is never decoded for filesystem access.
  try {
    if (invalidShape(decodeURIComponent(relative))) return { rule: "path.invalid", message: "Percent encoding hides unsafe canonical path components" };
  } catch { /* Not a URL: malformed percent sequences remain literal filename characters. */ }
  return undefined;
}

/** Inspect ancestors before the target, never following a symlink. Missing tails are safe for future writes. */
export function inspectContainedPath(root: string, relative: string): { ok: true; full: string; stat: fs.Stats | undefined } | { ok: false; problem: PathProblem } {
  const invalid = relative === "" ? undefined : canonicalPathProblem(relative);
  if (invalid) return { ok: false, problem: invalid };
  const parts = relative ? relative.split("/") : [];
  let full = root;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) full = path.join(full, parts[i - 1] ?? "");
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return { ok: false, problem: { rule: "path.symlink", message: "Refusing symlinked target or ancestor: " + (parts.slice(0, i).join("/") || "<vault>") } };
    if (!stat) return { ok: true, full: path.join(root, relative), stat: undefined };
    if (i === parts.length) return { ok: true, full, stat };
    if (!stat.isDirectory()) return { ok: false, problem: { rule: "path.kind", message: "Expected a directory ancestor: " + parts.slice(0, i).join("/") } };
  }
  throw new Error("Unreachable path inspection");
}
