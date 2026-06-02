import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { TemplateType } from "../schema/load";
import { artifactDirectory } from "./paths";
import { ARTIFACTS } from "./registry";

export async function nextId(type: TemplateType, vaultRoot: string, project: string): Promise<string> {
  const prefix = ARTIFACTS[type].prefix;
  const directory = artifactDirectory(type, vaultRoot, project);
  // Docs may be organized into category subfolders; ids stay globally unique
  // per project, so scan recursively for that type. Other types stay flat.
  const entries = type === "doc" ? await readMarkdownNamesRecursive(directory) : await readdir(directory);

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

  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
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
