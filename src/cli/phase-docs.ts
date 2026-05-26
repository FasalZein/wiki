import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { booleanValue, stringValue, type ParsedCommand } from "./parse";

export type PhaseDocOptions = {
  noDoc: boolean;
  docPhase?: string;
};

export function phaseDocOptions(parsed: ParsedCommand): PhaseDocOptions {
  return {
    noDoc: booleanValue(parsed.values, "no-doc"),
    docPhase: stringValue(parsed.values, "doc-phase"),
  };
}

export async function loadPhaseDoc(repo: string, phase: string): Promise<string | null> {
  try {
    return await readFile(phaseDocPath(repo, phase), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

export async function writePhaseDocToStderr(repo: string, phase: string, options: PhaseDocOptions = { noDoc: false }): Promise<void> {
  if (options.noDoc) return;
  const selectedPhase = options.docPhase ?? phase;
  const doc = await loadPhaseDoc(repo, selectedPhase);
  if (doc === null) {
    console.error(`phase doc missing: ${selectedPhase}`);
    return;
  }
  console.error(`--- phase doc: ${selectedPhase} ---`);
  process.stderr.write(doc.endsWith("\n") ? doc : `${doc}\n`);
}

export function phaseDocPath(repo: string, phase: string): string {
  return join(repo, "skills", "wiki", `PHASE-${phase.toUpperCase()}.md`);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
