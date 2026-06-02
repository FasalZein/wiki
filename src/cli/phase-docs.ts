import { booleanValue, stringValue, type ParsedCommand } from "./parse";
import { loadPhaseGuidance } from "./guidance";

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

/**
 * Resolve the inline guidance for a phase. Guidance is CLI-owned (src/cli/guidance.ts,
 * ADR-0024/0026), not read from forked skill files. Returns null when a phase has
 * no guidance (e.g. ad-hoc).
 */
export function loadPhaseDoc(phase: string): string | null {
  return loadPhaseGuidance(phase);
}

export async function writePhaseDocToStderr(phase: string, options: PhaseDocOptions = { noDoc: false }): Promise<void> {
  if (options.noDoc) return;
  const selectedPhase = options.docPhase ?? phase;
  const doc = loadPhaseDoc(selectedPhase);
  if (doc === null) {
    console.error(`no phase guidance for: ${selectedPhase}`);
    return;
  }
  console.error(`--- phase doc: ${selectedPhase} ---`);
  process.stderr.write(doc.endsWith("\n") ? doc : `${doc}\n`);
}
