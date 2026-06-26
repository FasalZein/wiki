/**
 * Identity-graph primitives backed by the frontmatter-`id` spine: reduce a link
 * reference to its bare id, decide whether an id is a local (this-project,
 * registered-prefix) reference, gather every reference out of a file, and walk the
 * id index for inbound backlinks. These sit beside `buildIdIndex` (the spine) so
 * doctor (drift), `links` (graph read), and `mutate` (delete guard) share one
 * implementation instead of reaching across layers.
 */
import matter from "gray-matter";
import { readFile } from "node:fs/promises";

import { PREFIX_TO_TYPE } from "./registry";

/** A bare `PREFIX-NNNN` id, the only wikilink form the dangling-link check validates.
 *  Path-qualified links (`[[../other-project/...]]`) are cross-project and skipped. */
const BARE_ID_RE = /^[A-Z]+-\d+$/;
/** All `[[target]]` occurrences in a body; the target is captured for normalization. */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Reduce a link reference (a frontmatter value or a wikilink target) to its bare id
 *  candidate: strip wrapping `[[ ]]`, drop any `|alias` and `#heading`, and trim. A
 *  reference containing a path separator is cross-project and returns undefined (skip). */
export function bareIdOf(raw: string): string | undefined {
  let value = raw.trim();
  const wl = /^\[\[(.+)\]\]$/.exec(value);
  if (wl !== null) value = wl[1]!.trim();
  value = value.split("|")[0]!.split("#")[0]!.trim();
  if (value.includes("/") || value.includes("\\")) return undefined; // cross-project
  return value;
}

/** True when an id should be validated against this project's id set: it is a bare
 *  `PREFIX-NNNN` whose prefix is a registered kind. Unknown prefixes are cross-prefix
 *  (external) references and are skipped, as PRD-0013 documents. */
export function isLocalIdRef(id: string): boolean {
  if (!BARE_ID_RE.test(id)) return false;
  const prefix = id.split("-")[0]!;
  return PREFIX_TO_TYPE[prefix] !== undefined;
}

/** Every link reference in one file: frontmatter string/array values plus body
 *  `[[..]]` wikilinks. Validation/skip decisions are the caller's; this just gathers. */
export async function collectReferences(path: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const refs: string[] = [];
  const parsed = matter(content);
  for (const [name, value] of Object.entries(parsed.data as Record<string, unknown>)) {
    if (name === "id") continue;
    if (typeof value === "string") refs.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") refs.push(item);
    }
  }
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(parsed.content)) !== null) refs.push(match[1]!);
  return refs;
}

/** Every artifact id (other than `id`) whose frontmatter/body references `id`. */
export async function inboundReferences(index: Map<string, string[]>, id: string): Promise<string[]> {
  const inbound = new Set<string>();
  for (const [otherId, paths] of index) {
    if (otherId === id) continue;
    for (const path of paths) {
      for (const ref of await collectReferences(path)) {
        if (bareIdOf(ref) === id) inbound.add(otherId);
      }
    }
  }
  return [...inbound].sort();
}
