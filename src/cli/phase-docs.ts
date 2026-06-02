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

/**
 * Pure renderer: the labeled phase-doc block for a phase, or null when unmapped.
 * Both emitters below (stdout for status' primary output, stderr for action-verb
 * side-channel) render through this one function so the banner/newline/null policy
 * lives in a single place — only the stream and fatality differ.
 */
export function renderPhaseDoc(phase: string): string | null {
  const doc = loadPhaseDoc(phase);
  if (doc === null) return null;
  const body = doc.endsWith("\n") ? doc : `${doc}\n`;
  return `--- phase doc: ${phase} ---\n${body}`;
}

/** Emit guidance to stdout (status --with-doc: the doc is primary, scriptable output). */
export function writePhaseDocToStdout(phase: string): boolean {
  const rendered = renderPhaseDoc(phase);
  if (rendered === null) return false;
  process.stdout.write(rendered);
  return true;
}

export async function writePhaseDocToStderr(phase: string, options: PhaseDocOptions = { noDoc: false }): Promise<void> {
  if (options.noDoc) return;
  const selectedPhase = options.docPhase ?? phase;
  const rendered = renderPhaseDoc(selectedPhase);
  if (rendered === null) {
    console.error(`no phase guidance for: ${selectedPhase}`);
    return;
  }
  process.stderr.write(rendered);
}
