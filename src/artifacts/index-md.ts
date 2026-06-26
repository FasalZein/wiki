import matter from "gray-matter";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { TemplateType } from "../schema/load";
import { listProjects } from "../config/project";
import { DEFAULT_STRUCTURE, type Structure } from "./registry";
import { projectPath } from "./paths";

type Entry = {
  kind: TemplateType;
  id: string;
  title: string;
  summary: string;
  status: string;
  group: string;
  path: string;
};

/** Hidden sidecar holding the parsed roster keyed by path+mtime, so a regen only
 *  re-reads files whose mtime moved instead of parsing the whole tree each sync.
 *  The dot-prefix keeps it out of readdir's artifact scan (it skips non-.md anyway). */
const CACHE_FILE = ".index-cache.json";

type CacheRecord = { mtimeMs: number; entry: Entry | null }; // entry null = id-less (Unindexed)
type Cache = Record<string, CacheRecord>;

const DEFAULT_GROUP = "General";

/** How many files this regen parsed fresh vs. served from the mtime cache. */
export type RegenStats = { parsed: number; reused: number };

async function loadCache(root: string): Promise<Cache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, CACHE_FILE), "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Cache) : {};
  } catch {
    return {}; // missing or corrupt cache → cold rebuild, never a hard failure
  }
}

/** Definition-order kind ranking from the structure — a stable total order for sort,
 *  independent of readdir's unstable traversal order. */
function kindOrder(structure: Structure): TemplateType[] {
  return Object.keys(structure.kinds) as TemplateType[];
}

function field(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  return typeof value === "string" ? value : "";
}

/**
 * Generate `projects/<project>/index.md` — a plain-markdown roster of every
 * artifact in the project, read from frontmatter. Sorted by kind then id; idempotent
 * (same vault state → byte-identical file). Called only by `wiki sync`; create stays pure.
 * Incremental: a `.index-cache.json` sidecar keyed by path+mtime lets a regen reuse
 * unchanged entries and only parse files whose mtime moved (or new files).
 * ponytail: list, not a table — summaries can contain `|` and would break table cells.
 */
export async function writeProjectIndex(vaultRoot: string, project: string, structure: Structure = DEFAULT_STRUCTURE): Promise<RegenStats> {
  const root = projectPath(vaultRoot, project);
  const files = await readdir(root, { recursive: true });
  const cache = await loadCache(root);
  const nextCache: Cache = {};
  const entries: Entry[] = [];
  const unindexed: string[] = []; // id-less files, skipped from the roster but surfaced in a trailer
  let parsed = 0;
  let reused = 0;

  for (const rel of files) {
    if (!rel.endsWith(".md") || rel === "index.md" || rel === "_project.md") continue;
    const relPath = rel.split(sep).join("/"); // stable, forward-slash path for output
    const full = join(root, rel);
    const mtimeMs = (await stat(full)).mtimeMs;

    // Reuse the cached parse when the file's mtime hasn't moved — the whole point
    // of incremental: skip the read+frontmatter-parse for untouched files.
    const cached = cache[relPath];
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      reused += 1;
      nextCache[relPath] = cached;
      if (cached.entry === null) unindexed.push(relPath);
      else entries.push(cached.entry);
      continue;
    }

    parsed += 1;
    const data = matter(await readFile(full, "utf8")).data as Record<string, unknown>;
    const id = field(data, "id");
    if (id === "") {
      unindexed.push(relPath); // skipped for lacking an id — listed in the Unindexed trailer
      nextCache[relPath] = { mtimeMs, entry: null };
      continue;
    }
    const kind = structure.typeForId(id);
    if (kind === undefined) continue; // skip non-artifact / unrecognized files
    const entry: Entry = {
      kind,
      id,
      title: field(data, "title"),
      summary: field(data, "summary"),
      status: field(data, "status"),
      group: field(data, "group") || DEFAULT_GROUP,
      path: relPath,
    };
    entries.push(entry);
    nextCache[relPath] = { mtimeMs, entry };
  }

  const KIND_ORDER = kindOrder(structure);
  entries.sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    const i = a.id.localeCompare(b.id);
    return i !== 0 ? i : a.path.localeCompare(b.path); // path tiebreaker keeps dup ids stable
  });

  // Ids that map to more than one file get disambiguated inline so the roster never
  // silently understates the vault (duplicate-id drift is also flagged by `wiki doctor`).
  const idCounts = new Map<string, number>();
  for (const e of entries) idCounts.set(e.id, (idCounts.get(e.id) ?? 0) + 1);

  // Group headings ordered alphabetically, but General always last.
  const groups = [...new Set(entries.map((e) => e.group))].sort((a, b) => {
    if (a === DEFAULT_GROUP) return 1;
    if (b === DEFAULT_GROUP) return -1;
    return a.localeCompare(b);
  });

  const lines = [`# ${project} index`, ""];
  for (const group of groups) {
    lines.push(`## ${group}`, "");
    for (const e of entries.filter((e) => e.group === group)) {
      const status = e.status === "" ? "" : ` (${e.status})`;
      const summary = e.summary === "" ? "" : ` — ${e.summary}`;
      // disambiguate only when the id collides — otherwise the line stays clean
      const disambig = (idCounts.get(e.id) ?? 0) > 1 ? ` [${e.path}]` : "";
      lines.push(`- [[${e.id}]] ${e.title}${status}${summary}${disambig}`);
    }
    lines.push("");
  }

  // Trailer: files skipped for lacking an id, so the roster doesn't silently hide them.
  if (unindexed.length > 0) {
    lines.push("## Unindexed (no id)", "");
    for (const path of [...unindexed].sort((a, b) => a.localeCompare(b))) {
      lines.push(`- ${path}`);
    }
    lines.push("");
  }

  await writeFile(join(root, "index.md"), lines.join("\n"));
  await writeFile(join(root, CACHE_FILE), JSON.stringify(nextCache));
  return { parsed, reused };
}

/**
 * Generate the top-level `index.md` at the vault root — a roster of every project,
 * each linking to its per-project roster. Sorted by name; idempotent. Called by
 * `wiki sync` after the per-project index so the vault has a single entry point.
 */
export async function writeVaultIndex(vaultRoot: string): Promise<void> {
  const projects = await listProjects(vaultRoot);
  const lines = ["# Vault index", ""];
  for (const project of projects) {
    lines.push(`- [[projects/${project}/index.md|${project}]]`);
  }
  lines.push("");
  await writeFile(join(vaultRoot, "index.md"), lines.join("\n"));
}
