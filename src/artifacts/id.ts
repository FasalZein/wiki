import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { TemplateType } from "../schema/load";
import { buildIdIndex } from "./id-index";
import { artifactDirectory } from "./paths";
import { type Structure } from "./registry";

export async function nextId(type: TemplateType, vaultRoot: string, project: string, structure: Structure): Promise<string> {
  const prefix = structure.specFor(type).prefix;
  const directory = artifactDirectory(type, vaultRoot, project, structure);
  // SLICE-0111: id allocation keys on the SECTION, not the kind. A section folder
  // may hold bucket subfolders (a branch section) whose artifacts all share the
  // section prefix and id-space, so scan the section folder recursively for every
  // type. A leaf section has no subfolders, so a recursive scan equals a flat read.
  const entries = await readMarkdownNamesRecursive(directory);

  const prefixPattern = new RegExp(`^${prefix}-(\\d{3,})(?:-.+)?\\.md$`);
  const adrPattern = /^(\d{3,})-.+\.md$/;

  let highest = 0;

  for (const entry of entries) {
    const prefixMatch = prefixPattern.exec(entry);
    if (prefixMatch?.[1] !== undefined) {
      highest = Math.max(highest, Number.parseInt(prefixMatch[1], 10));
      continue;
    }

    if (type === "decision") {
      const adrMatch = adrPattern.exec(entry);
      if (adrMatch?.[1] !== undefined) {
        highest = Math.max(highest, Number.parseInt(adrMatch[1], 10));
      }
    }
  }

  // Frontmatter id is the real spine: a date-named or id-only file whose
  // frontmatter id outranks every filename must still bump the counter, or
  // create re-mints a colliding id. Take the max of filename and frontmatter.
  highest = Math.max(highest, await highestFrontmatterId(prefix, vaultRoot, project, structure));

  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}

/** The largest numeric suffix among frontmatter ids that share this prefix. */
async function highestFrontmatterId(prefix: string, vaultRoot: string, project: string, structure: Structure): Promise<number> {
  const idPattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const id of (await buildIdIndex(vaultRoot, project, structure)).keys()) {
    const match = idPattern.exec(id);
    if (match?.[1] !== undefined) {
      highest = Math.max(highest, Number.parseInt(match[1], 10));
    }
  }
  return highest;
}

async function readMarkdownNamesRecursive(directory: string): Promise<string[]> {
  const names: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(...await readMarkdownNamesRecursive(join(directory, entry.name)));
    } else if (entry.isFile()) {
      names.push(entry.name);
    }
  }
  return names;
}
