import * as fs from "node:fs";
import * as path from "node:path";
import { createFileExclusive, sha256, type Vault } from "./store.ts";
import { AUTHORITIES, type Authority, assertNoteId, type Digest, WikiError } from "./types.ts";

/** One capture of a note file: identity, digest, and body all come from these bytes. */
export interface NoteSnapshot {
  id: string;
  /** Path relative to the vault root. */
  path: string;
  bytes: Uint8Array;
  digest: Digest;
  authority: Authority;
  title: string | null;
  /** Top-level scalar frontmatter fields, as authored. Never a trust source. */
  frontmatter: Record<string, string>;
  body: string;
}

const SKIP_DIRS = new Set([".wiki", ".git", ".obsidian", "node_modules"]);

/**
 * Split frontmatter and body. Only top-level `key: value` scalars are read;
 * nested YAML is ignored rather than evaluated. Values written by this core
 * are JSON strings, which are valid YAML double-quoted scalars.
 */
export function parseNoteText(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as string;
    let value = kv[2] as string;
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        // Keep the authored text when it is not a JSON-compatible quoted scalar.
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

function snapshotFromBytes(vault: Vault, file: string, bytes: Uint8Array): NoteSnapshot | null {
  const text = new TextDecoder().decode(bytes);
  const { frontmatter, body } = parseNoteText(text);
  const id = frontmatter.id;
  if (id === undefined) return null;
  const authority = frontmatter.authority;
  const rel = path.relative(vault.root, file);
  if (!AUTHORITIES.includes(authority as Authority)) {
    throw new WikiError("invalid_input", `note ${id} (${rel}) has no valid authority; expected one of ${AUTHORITIES.join(", ")}`);
  }
  return {
    id,
    path: rel,
    bytes,
    digest: sha256(bytes),
    authority: authority as Authority,
    title: frontmatter.title ?? null,
    frontmatter,
    body,
  };
}

function* markdownFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* markdownFiles(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield path.join(dir, entry.name);
    }
  }
}

/** Find a note by frontmatter id anywhere in the vault, reading its bytes exactly once. */
export function loadNote(vault: Vault, id: string): NoteSnapshot {
  assertNoteId(id);
  const found: NoteSnapshot[] = [];
  for (const file of markdownFiles(vault.root)) {
    const bytes = fs.readFileSync(file);
    // Cheap prefilter before parsing; identity still comes from parsed frontmatter.
    if (!Buffer.from(bytes).includes(id)) continue;
    const text = new TextDecoder().decode(bytes);
    if (parseNoteText(text).frontmatter.id !== id) continue;
    const snap = snapshotFromBytes(vault, file, bytes);
    if (snap) found.push(snap);
  }
  if (found.length === 0) throw new WikiError("not_found", `no note with id ${id}`);
  if (found.length > 1) {
    throw new WikiError("conflict", `duplicate note id ${id}: ${found.map((n) => n.path).join(", ")}`);
  }
  return found[0] as NoteSnapshot;
}

export interface CreateNoteInput {
  id: string;
  authority: Authority;
  title: string;
  body: string;
  /** ISO date-time; defaults to now. */
  created?: string;
}

/** Create a new note file. Never overwrites an existing file or reuses an id. */
export function createNote(vault: Vault, input: CreateNoteInput): NoteSnapshot {
  assertNoteId(input.id);
  if (!AUTHORITIES.includes(input.authority)) {
    throw new WikiError("invalid_input", `authority must be one of ${AUTHORITIES.join(", ")}`);
  }
  try {
    const existing = loadNote(vault, input.id);
    throw new WikiError("exists", `note id ${input.id} already exists at ${existing.path}`);
  } catch (error) {
    if (!(error instanceof WikiError) || error.code !== "not_found") throw error;
  }
  const created = input.created ?? new Date().toISOString();
  const text = [
    "---",
    `id: ${JSON.stringify(input.id)}`,
    `authority: ${JSON.stringify(input.authority)}`,
    `title: ${JSON.stringify(input.title)}`,
    `created: ${JSON.stringify(created)}`,
    "---",
    input.body,
  ].join("\n");
  const file = path.join(vault.root, "notes", `${input.id}.md`);
  if (!createFileExclusive(vault, file, text)) {
    throw new WikiError("exists", `refusing to overwrite existing file notes/${input.id}.md`);
  }
  return loadNote(vault, input.id);
}
