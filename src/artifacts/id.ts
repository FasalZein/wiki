import { readdir } from "node:fs/promises";

import type { TemplateType } from "../schema/load";
import { artifactDirectory } from "./paths";

export async function nextId(type: TemplateType, vaultRoot: string, project: string): Promise<string> {
  const prefix = idPrefix(type);
  const directory = artifactDirectory(type, vaultRoot, project);
  const entries = await readdir(directory);

  const prefixPattern = new RegExp(`^${prefix}-(\\d{3,})\\.md$`);
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
