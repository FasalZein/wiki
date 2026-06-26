/**
 * Machine-readable output (P1.1). A single global `--json` flag, stripped in
 * dispatch, flips every json-aware verb to emit one stable object to stdout on
 * success — and the `{error,...}` shape to stderr on failure, so an agent can
 * detect failure programmatically instead of scraping prose (complaint #15).
 * Diagnostics (the context banner, "created ..." sentences) stay on stderr.
 */

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function jsonEnabled(): boolean {
  return jsonMode;
}

/** Stable success object → stdout (json mode only; callers print human prose otherwise). */
export function emitJson(obj: Record<string, unknown>): void {
  console.log(JSON.stringify(obj));
}

/** Stable success array → stdout (json mode only) — e.g. search hits. */
export function emitJsonArray(items: unknown[]): void {
  console.log(JSON.stringify(items));
}

/** Error object → stderr (json mode only). */
export function emitJsonError(obj: Record<string, unknown>): void {
  console.error(JSON.stringify(obj));
}
