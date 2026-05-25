import { readdir } from "node:fs/promises";

import type { TemplateType } from "../schema/load";
import { artifactDirectory } from "./paths";

export async function nextId(type: TemplateType, vaultRoot: string, project: string): Promise<string> {
  const prefix = idPrefix(type);
  const directory = artifactDirectory(type, vaultRoot, project);
  const entries = await readdir(directory);
  const used = new Set<number>();

  for (const entry of entries) {
    const match = new RegExp(`^${prefix}-(\\d{4,})\\.md$`).exec(entry);
    if (match !== null) {
      const value = match[1];
      if (value !== undefined) {
        used.add(Number.parseInt(value, 10));
      }
    }
  }

  let next = 1;
  while (used.has(next)) {
    next += 1;
  }

  return `${prefix}-${String(next).padStart(4, "0")}`;
}

function idPrefix(type: TemplateType): string {
  switch (type) {
    case "decision":
      return "DECISION";
    case "prd":
      return "PRD";
    case "slice":
      return "SLICE";
    case "handover":
      return "HANDOVER";
  }
}
