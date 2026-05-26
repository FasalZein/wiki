import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CliResult } from "../dispatch";

export async function handlePhase(args: string[]): Promise<CliResult> {
  const [subverb, name] = args;
  if (subverb !== "doc") {
    console.error(`unknown phase subverb: ${subverb ?? ""}`.trim());
    return { code: 1 };
  }
  if (name === undefined) {
    console.error("missing required field: name");
    return { code: 1 };
  }
  const doc = await readPhaseDoc(process.cwd(), name);
  if (doc === null) {
    console.error(`phase doc not found: ${name}`);
    return { code: 1 };
  }
  process.stdout.write(doc);
  if (!doc.endsWith("\n")) process.stdout.write("\n");
  return { code: 0 };
}

export async function readPhaseDoc(repo: string, name: string): Promise<string | null> {
  try {
    return await readFile(phaseDocPath(repo, name), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

export function phaseDocPath(repo: string, name: string): string {
  return join(repo, "skills", "wiki", `PHASE-${name.toUpperCase()}.md`);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
