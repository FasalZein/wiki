import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  // Prefer a project-repo override if present, otherwise fall back to the CLI's
  // own bundled skill docs. The phase docs ship with the skill, not each project
  // repo, so without this fallback only the wiki repo itself resolves them.
  // Transition phases (green/close) have no dedicated doc; they alias to the
  // slice/TDD doc per the skill's phase routing.
  const candidates = [
    phaseDocPath(repo, phase),
    bundledPhaseDocPath(phase),
    bundledPhaseDocPath(bundleAlias(phase)),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
  }
  return null;
}

/** Maps transition phase names to the bundled doc that documents them. */
function bundleAlias(phase: string): string {
  switch (phase.toLowerCase()) {
    case "green":
    case "close":
      return "slice";
    default:
      return phase;
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

/** Resolve a phase doc from the CLI's own skill bundle (dev: src/.. ; built: dist/..). */
export function bundledPhaseDocPath(phase: string): string {
  const file = `PHASE-${phase.toUpperCase()}.md`;
  const fromSrc = resolve(import.meta.dir, "..", "..", "skills", "wiki", file);
  if (existsSync(fromSrc)) return fromSrc;
  return resolve(import.meta.dir, "..", "skills", "wiki", file);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
