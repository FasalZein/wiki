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
};

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
    });
  }

  entries.sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return k !== 0 ? k : a.id.localeCompare(b.id);
  });

  const lines = [`# ${project} index`, ""];
  for (const e of entries) {
    const status = e.status === "" ? "" : ` (${e.status})`;
    const summary = e.summary === "" ? "" : ` — ${e.summary}`;
    lines.push(`- [[${e.id}]] ${e.title}${status}${summary}`);
  }
  lines.push("");

  await writeFile(join(root, "index.md"), lines.join("\n"));
}
