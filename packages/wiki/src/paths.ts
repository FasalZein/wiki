import * as fs from "node:fs";
import * as path from "node:path";

type PathProblem = { rule: "path.invalid" | "path.symlink" | "path.kind"; message: string };
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

type ContainedPath = { ok: true; full: string; stat: fs.Stats | undefined } | { ok: false; problem: PathProblem };
function pathAncestors(root: string, relative: string): { full: string; relative: string }[] {
  const ancestors = [{ full: root, relative: "" }];
  const parts = relative ? relative.split("/") : [];
  for (const [i, part] of parts.entries()) {
    ancestors.push({ full: path.join(ancestors[i]!.full, part), relative: parts.slice(0, i + 1).join("/") });
  }
  return ancestors;
}
function pathEntryProblem(stat: fs.Stats, relative: string, ancestor: boolean): PathProblem | undefined {
  if (stat.isSymbolicLink()) return { rule: "path.symlink", message: "Refusing symlinked target or ancestor: " + (relative || "<vault>") };
  if (ancestor && !stat.isDirectory()) return { rule: "path.kind", message: "Expected a directory ancestor: " + relative };
  return undefined;
}
function inspectPathAncestors(root: string, relative: string): ContainedPath {
  const ancestors = pathAncestors(root, relative);
  for (const [i, item] of ancestors.entries()) {
    const stat = fs.lstatSync(item.full, { throwIfNoEntry: false });
    if (!stat) return { ok: true, full: path.join(root, relative), stat: undefined };
    const problem = pathEntryProblem(stat, item.relative, i < ancestors.length - 1);
    if (problem) return { ok: false, problem };
    if (i === ancestors.length - 1) return { ok: true, full: item.full, stat };
  }
  throw new Error("Unreachable path inspection");
}
/** Inspect ancestors before the target, never following a symlink. Missing tails are safe for future writes. */
export function inspectContainedPath(root: string, relative: string): ContainedPath {
  const invalid = relative === "" ? undefined : canonicalPathProblem(relative);
  if (invalid) return { ok: false, problem: invalid };
  return inspectPathAncestors(root, relative);
}
