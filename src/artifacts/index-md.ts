import matter from "gray-matter";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { TemplateType } from "../schema/load";
import { ARTIFACTS, typeForId } from "./registry";
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

const DEFAULT_GROUP = "General";

/** Definition-order kind ranking from wiki.json — a stable total order for sort,
 *  independent of readdir's unstable traversal order. */
const KIND_ORDER: TemplateType[] = Object.keys(ARTIFACTS) as TemplateType[];

function field(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  return typeof value === "string" ? value : "";
}

/**
 * Generate `projects/<project>/index.md` — a plain-markdown roster of every
 * artifact in the project, read from frontmatter. Sorted by kind then id; idempotent
 * (same vault state → byte-identical file). Called only by `wiki sync`; create stays pure.
 * ponytail: list, not a table — summaries can contain `|` and would break table cells.
 */
export async function writeProjectIndex(vaultRoot: string, project: string): Promise<void> {
  const root = projectPath(vaultRoot, project);
  const files = await readdir(root, { recursive: true });
  const entries: Entry[] = [];
  const unindexed: string[] = []; // id-less files, skipped from the roster but surfaced in a trailer

  for (const rel of files) {
    if (!rel.endsWith(".md") || rel === "index.md" || rel === "_project.md") continue;
    const relPath = rel.split(sep).join("/"); // stable, forward-slash path for output
    const parsed = matter(await readFile(join(root, rel), "utf8"));
    const data = parsed.data as Record<string, unknown>;
    const id = field(data, "id");
    if (id === "") {
      unindexed.push(relPath); // skipped for lacking an id — listed in the Unindexed trailer
      continue;
    }
    const kind = typeForId(id);
    if (kind === undefined) continue; // skip non-artifact / unrecognized files
    entries.push({
      kind,
      id,
      title: field(data, "title"),
      summary: field(data, "summary"),
      status: field(data, "status"),
      group: field(data, "group") || DEFAULT_GROUP,
      path: relPath,
    });
  }

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
}
