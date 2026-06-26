import matter from "gray-matter";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { projectPath } from "./paths";
import { ARTIFACTS } from "./registry";

/**
 * The frontmatter-`id` -> absolute-path index for one project. An id mapping to
 * more than one path is a duplicate (doctor flags those); id-less files never
 * appear. This is the single spine reused by resolution, allocation, duplicate
 * detection, and link validation — filename is no longer the source of truth.
 */
export async function buildIdIndex(vaultRoot: string, project: string): Promise<Map<string, string[]>> {
  const root = projectPath(vaultRoot, project);
  const index = new Map<string, string[]>();
  // Folders are data in wiki.json; a Set dedups kinds that share a folder.
  for (const folder of new Set(Object.values(ARTIFACTS).map((spec) => spec.folder))) {
    await collectIds(join(root, folder), index);
  }
  return index;
}

async function collectIds(directory: string, index: Map<string, string[]>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // folder may not exist yet — nothing to index
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectIds(full, index);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const id = await readFrontmatterId(full);
      if (id === undefined) continue;
      const paths = index.get(id);
      if (paths === undefined) index.set(id, [full]);
      else paths.push(full);
    }
  }
}

async function readFrontmatterId(path: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const id = matter(content).data.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
