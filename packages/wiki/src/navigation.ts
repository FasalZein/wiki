import * as fs from "node:fs";
import * as path from "node:path";
import { inspectContainedPath } from "./paths.ts";
import { safeName, type Diagnostic, type RegisteredType } from "./registry.ts";

export interface NavigationTopic { path: string; type: string; title: string; description: string }
export interface NavigationDirectory { path: string; type: string }
function isNavigationRoot(directory: string): boolean {
  return directory === "" || directory === "personal" || directory === "projects" || directory.startsWith("projects/") && directory.split("/").length === 2 && safeName(directory.slice(9));
}
function typeDirectoryScope(directory: string): string | undefined {
  const parts = directory.split("/");
  const [area, project = ""] = parts;
  if (area === "personal") return directory.slice(9).includes("/") ? undefined : "personal";
  if (parts.length !== 3 || area !== "projects" || !safeName(project)) return undefined;
  return parts.slice(0, 2).join("/");
}
export function maintainedDirectory(directory: string, types: RegisteredType[]): NavigationDirectory | undefined {
  if (isNavigationRoot(directory)) return { path: directory, type: "" };
  const scope = typeDirectoryScope(directory);
  if (!scope) return undefined;
  const type = types.find(t => t.record.folder === directory.slice(scope.length + 1) && (!t.record.scopes || t.record.scopes.includes(scope)));
  return type ? { path: directory, type: type.record.name } : undefined;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function markdownText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\\x60*_{}\[\]()!#|~]/g, "\\$&");
}
interface NavigationRow { type: string; path: string; row: string }
function navigationDirectoryRows(directories: NavigationDirectory[], topics: NavigationTopic[]): Map<string, NavigationRow[]> {
  const rows = new Map<string, NavigationRow[]>();
  for (const directory of directories) rows.set(directory.path, []);
  for (const directory of directories) {
    if (!directory.path) continue;
    const parent = path.posix.dirname(directory.path) === "." ? "" : path.posix.dirname(directory.path);
    const count = topics.filter(n => n.path.startsWith(directory.path + "/")).length;
    rows.get(parent)?.push({ type: directory.type, path: directory.path,
      row: "* [" + markdownText(path.posix.basename(directory.path)) + "](" + path.posix.relative(parent, directory.path + "/index.md") + ") - " + count + " concept" + (count === 1 ? "" : "s") });
  }
  return rows;
}
function renderNavigationIndex(directory: string, items: NavigationRow[]): string {
  items.sort((a, b) => compare(a.type, b.type) || compare(a.path, b.path));
  const heading = directory ? "# " + markdownText(path.posix.basename(directory)) : '---\nokf_version: "0.2"\n---\n# Wiki';
  return heading + (items.length ? "\n\n" + items.map(i => i.row).join("\n") : "") + "\n";
}
export function renderIndexes(directories: NavigationDirectory[], topics: NavigationTopic[]): Map<string, string> {
  const rows = navigationDirectoryRows(directories, topics);
  for (const note of topics) rows.get(path.posix.dirname(note.path))?.push({ type: note.type, path: note.path,
    row: "* [" + markdownText(note.title) + "](" + path.posix.basename(note.path) + ") - " + markdownText(note.description) });
  const output = new Map<string, string>();
  for (const [directory, items] of [...rows].sort(([a], [b]) => compare(a, b))) {
    output.set(directory ? directory + "/index.md" : "index.md", renderNavigationIndex(directory, items));
  }
  return output;
}
function indexDestinationProblem(root: string, relative: string): Diagnostic | undefined {
  const inspected = inspectContainedPath(root, relative);
  const problem = !inspected.ok ? inspected.problem : inspected.stat && !inspected.stat.isFile()
    ? { rule: "path.kind", message: "Generated index destination must be a regular file" } : undefined;
  if (!problem) return undefined;
  return { path: relative, rule: problem.rule, message: problem.message,
    fix: "Remove the unsafe destination and use a regular vault-owned index.md file" };
}
// Check every destination before publishing any output. This is not a multi-file transaction.
export function indexDestinationDiagnostics(root: string, targets: Iterable<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const relative of targets) {
    const problem = indexDestinationProblem(root, relative);
    if (problem) diagnostics.push(problem);
  }
  return diagnostics;
}
function indexFreshnessProblem(root: string, relative: string, bytes: string): Diagnostic | undefined {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) return undefined;
  let rule: string, message: string;
  if (!inspected.stat) {
    rule = "index.missing";
    message = "Missing generated navigation index";
  } else if (!fs.readFileSync(inspected.full).equals(Buffer.from(bytes))) {
    rule = "index.stale";
    message = "Generated navigation differs from current topic metadata";
  } else return undefined;
  return { path: relative, rule, message, fix: "Run wiki --vault <dir> index to regenerate navigation" };
}
export function indexFreshnessDiagnostics(root: string, expected: Map<string, string>): Diagnostic[] {
  const diagnostics = indexDestinationDiagnostics(root, expected.keys());
  const unsafe = new Set(diagnostics.map(d => d.path));
  for (const [relative, bytes] of expected) {
    if (unsafe.has(relative)) continue;
    const problem = indexFreshnessProblem(root, relative, bytes);
    if (problem) diagnostics.push(problem);
  }
  return diagnostics;
}
