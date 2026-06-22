# Plan 004 — Guard the qmd JSON parse so malformed output degrades, not crashes

Target commit: `5dbf09f`. If `src/integrations/qmd.ts` has drifted from the excerpt below,
STOP and report.

## Why
`parseQmdResults` does `JSON.parse(stdout)` with no try/catch. Every other qmd failure path
throws `QmdError`, which callers catch and degrade gracefully ("dedup check skipped", empty
results). But if `qmd` exits 0 and emits non-JSON on stdout (version skew, a warning banner,
partial output), the raw `SyntaxError` bypasses the `QmdError`/`DedupBlockedError` catches in
`advisoryDedup` (`create.ts:227-251`) and crashes the whole `create`/`sync`. The module's own
header comment admits it "depends on that human-readable output shape." This parser is also
the single place wiki interprets retrieval output and has zero unit tests.

## Current code (`src/integrations/qmd.ts:83-122`)
```ts
async function runQmd(command: string, args: string[]): Promise<string> {
  ... // returns stdout
}

function parseQmdResults(stdout: string): QmdResult[] {
  const parsed: unknown = JSON.parse(stdout);          // <-- unguarded
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    if (!isRecord(item)) return [];
    const path = stringField(item, "path") ?? stringField(item, "file") ?? stringField(item, "filename");
    if (path === undefined) return [];
    return [{ path, ... }];
  });
}
```
`QmdError` is already defined in this file and constructed as `new QmdError(message)` (see
lines 88, 97). `runQuery` (line ~80) calls `parseQmdResults(stdout)`.

## What to change (in `src/integrations/qmd.ts`)
1. Wrap the parse and throw `QmdError` on failure, so the existing graceful-degradation
   catches absorb it:
```ts
function parseQmdResults(stdout: string): QmdResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new QmdError(`qmd returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  ... // unchanged
}
```
2. Export `parseQmdResults` (change `function parseQmdResults` → `export function
   parseQmdResults`) so it can be unit-tested directly.

## Out of scope — do NOT touch
- `runQmd`'s exit-code handling (it's correct).
- The dedup/advisory logic in `create.ts` (it already catches `QmdError`; this change just
  makes the parse failure reach that catch).
- Do NOT add a schema-validation layer for qmd output — the field-fallback flatMap is
  sufficient; just stop the crash.

## Verification
`bun run build && bunx tsc --noEmit && bun test tests/` — all green. New tests pass.

## Test plan
Add `tests/qmd-parse.test.ts` (no fixture needed — pure function). Import `parseQmdResults`
and assert:
- valid array with `path`, `snippet`/`text`, numeric `score` → parsed result.
- field fallbacks: an item with `file` (not `path`) resolves; `filename` resolves; an item
  with none → dropped.
- score as string vs number both handled (match whatever the current `stringField`/score
  logic does — read it and assert the actual behavior, don't assume).
- non-array JSON (e.g. `"{}"`) → `[]`.
- malformed JSON (e.g. `"not json"`) → throws `QmdError` (use `expect(() => ...).toThrow`).

## Maintenance note
If qmd's `--json` output shape changes, this parser and its test are the one place to update.
The graceful-degradation contract is: any qmd misbehavior surfaces as `QmdError`, never an
uncaught throw — preserve that for any future qmd integration call.
