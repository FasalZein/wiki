import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Harness } from "./types";

export function detectHarness(): Harness {
  if (isSet(process.env.PI_SESSION_ID) || isSet(process.env.PI_AGENT)) {
    return "pi";
  }
  if (isSet(process.env.CLAUDECODE) || isSet(process.env.CLAUDE_CODE_ENTRYPOINT)) {
    return "claude-code";
  }
  if (isSet(process.env.CODEX_HOME) || isSet(process.env.OPENAI_CODEX)) {
    return "codex";
  }
  if (piFallbackMarkerExists()) {
    return "pi";
  }
  return "none";
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function piFallbackMarkerExists(): boolean {
  const home = process.env.HOME;
  return home !== undefined && home.length > 0 && existsSync(join(home, ".pi"));
}
