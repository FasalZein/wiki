import matter from "gray-matter";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

  for (const rel of files) {
    if (!rel.endsWith(".md") || rel === "index.md" || rel === "_project.md") continue;
    const parsed = matter(await readFile(join(root, rel), "utf8"));
    const data = parsed.data as Record<string, unknown>;
    const id = field(data, "id");
    const kind = id === "" ? undefined : typeForId(id);
    if (kind === undefined) continue; // skip non-artifact / unrecognized files
    entries.push({
      kind,
      id,
      title: field(data, "title"),
      summary: field(data, "summary"),
      status: field(data, "status"),
      group: field(data, "group") || DEFAULT_GROUP,
    });
  }

  entries.sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return k !== 0 ? k : a.id.localeCompare(b.id);
  });

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
      lines.push(`- [[${e.id}]] ${e.title}${status}${summary}`);
    }
    lines.push("");
  }

  await writeFile(join(root, "index.md"), lines.join("\n"));
}
