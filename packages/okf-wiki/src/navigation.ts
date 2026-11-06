import * as fs from "node:fs";
import * as path from "node:path";
import { inspectContainedPath } from "./paths.ts";
import { safeName, type Diagnostic, type RegisteredType } from "./registry.ts";

export interface NavigationTopic { path: string; type: string; title: string; description: string }
export interface NavigationDirectory { path: string; type: string }
export function maintainedDirectory(directory: string, types: RegisteredType[]): NavigationDirectory | undefined {
  if (directory === "" || directory === "personal" || directory === "projects" || directory.startsWith("projects/") && directory.split("/").length === 2 && safeName(directory.slice(9))) return { path: directory, type: "" };
  const parts = directory.split("/");
  const scope = parts[0] === "personal" ? "personal" : parts.length === 3 && parts[0] === "projects" ? parts.slice(0, 2).join("/") : undefined;
  if (!scope || scope.startsWith("projects/") && !safeName(parts[1] ?? "") || directory.slice(scope.length + 1).includes("/")) return undefined;
  const type = types.find(t => t.record.folder === directory.slice(scope.length + 1) && (!t.record.scopes || t.record.scopes.includes(scope)));
  return type ? { path: directory, type: type.record.name } : undefined;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function text(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\\x60*_{}\[\]()!#|~]/g, "\\$&");
}
export function renderIndexes(directories: NavigationDirectory[], topics: NavigationTopic[]): Map<string, string> {
  const rows = new Map<string, { type: string; path: string; row: string }[]>();
  for (const directory of directories) rows.set(directory.path, []);
  for (const directory of directories) {
    if (!directory.path) continue;
    const parent = path.posix.dirname(directory.path) === "." ? "" : path.posix.dirname(directory.path);
    const count = topics.filter(n => n.path.startsWith(directory.path + "/")).length;
    rows.get(parent)?.push({ type: directory.type, path: directory.path,
      row: "* [" + text(path.posix.basename(directory.path)) + "](" + path.posix.relative(parent, directory.path + "/index.md") + ") - " + count + " concept" + (count === 1 ? "" : "s") });
  }
  for (const note of topics) rows.get(path.posix.dirname(note.path))?.push({ type: note.type, path: note.path,
    row: "* [" + text(note.title) + "](" + path.posix.basename(note.path) + ") - " + text(note.description) });
  const output = new Map<string, string>();
  for (const [directory, items] of [...rows].sort(([a], [b]) => compare(a, b))) {
    items.sort((a, b) => compare(a.type, b.type) || compare(a.path, b.path));
    const heading = directory ? "# " + text(path.posix.basename(directory)) : '---\nokf_version: "0.2"\n---\n# Wiki';
    output.set(directory ? directory + "/index.md" : "index.md", heading + (items.length ? "\n\n" + items.map(i => i.row).join("\n") : "") + "\n");
  }
  return output;
}
// Check every destination before publishing any output. This is not a multi-file transaction.
export function indexDestinationDiagnostics(root: string, targets: Iterable<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const relative of targets) {
    const inspected = inspectContainedPath(root, relative);
    if (!inspected.ok || inspected.stat && !inspected.stat.isFile()) diagnostics.push({ path: relative,
      rule: !inspected.ok ? inspected.problem.rule : "path.kind",
      message: !inspected.ok ? inspected.problem.message : "Generated index destination must be a regular file",
      fix: "Remove the unsafe destination and use a regular vault-owned index.md file" });
  }
  return diagnostics;
}
export function indexFreshnessDiagnostics(root: string, expected: Map<string, string>): Diagnostic[] {
  const diagnostics = indexDestinationDiagnostics(root, expected.keys());
  const unsafe = new Set(diagnostics.map(d => d.path));
  for (const [relative, bytes] of expected) {
    if (unsafe.has(relative)) continue;
    const inspected = inspectContainedPath(root, relative);
    if (!inspected.ok) continue;
    const missing = !inspected.stat;
    if (missing || !fs.readFileSync(inspected.full).equals(Buffer.from(bytes))) diagnostics.push({ path: relative, rule: missing ? "index.missing" : "index.stale",
      message: missing ? "Missing generated navigation index" : "Generated navigation differs from current topic metadata",
      fix: "Run okf-wiki --vault <dir> index to regenerate navigation" });
  }
  return diagnostics;
}
