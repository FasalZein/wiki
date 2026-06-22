# Plan 003 — Make artifact ID allocation collision-safe (exclusive create + retry)

Target commit: `5dbf09f`. If `src/artifacts/id.ts` or `createArtifact`/`writeArtifact` in
`src/artifacts/store.ts` have drifted from the excerpts below, STOP and report.

## Why
`nextId` scans the directory for the highest existing number and returns `highest + 1`, with
no lock. `createArtifact` then computes the path and writes via a plain `Bun.write` (no
exclusive flag). Two near-simultaneous `wiki create` calls in the same project both compute
`N` before either writes → either two files share id `PRD-000N` (different titles), or the
second write silently overwrites the first (identical titles). Agent fan-out makes parallel
creates plausible.

## Current code
- `src/artifacts/id.ts:8-36` — `nextId`: `readdir` → `Math.max` over the pattern → `\`${prefix}-${String(highest + 1).padStart(4, "0")}\``.
- `src/artifacts/store.ts:153-194` — `createArtifact`: computes `id = await nextId(...)`, renders content, `path = artifactPath(...)`, then `await writeArtifact(path, content)`.
- `src/artifacts/store.ts:275-277` — `writeArtifact(path, content)` → `await Bun.write(path, content)` (shared by `relocateArtifact` and `writeFields`, which INTENTIONALLY overwrite — do NOT make those exclusive).

## What to change (in `src/artifacts/store.ts`)
Add an exclusive write and a bounded retry loop, used ONLY by `createArtifact`. Node's
`writeFile` with flag `wx` throws `EEXIST` if the path exists — that's the atomic guard.

1. Add the import (top of file): `import { writeFile } from "node:fs/promises";` (the file
   already imports other things from `node:fs/promises` — add to that import if present).
2. Refactor `createArtifact` so the `nextId → render → write` steps retry on collision.
   Keep it lazy — wrap the tail in a small loop:
```ts
  // ponytail: read-then-write on nextId is a TOCTOU race under parallel creates.
  // Exclusive create (flag 'wx') + bounded retry is the cheap fix — no lockfile.
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; ; attempt++) {
    const id = await nextId(input.type, input.vaultRoot, input.project);
    const aliases = ...; // (compute from id as today)
    const fields = applyDefaults(...);
    const result = validate(schema, fields);
    if (!result.ok) throw new ArtifactValidationError(result.errors);
    const content = renderArtifact(template, orderBySchema(schema, result.value), bodySections);
    const path = artifactPath(input.type, input.vaultRoot, input.project, id, String(result.value.title ?? id), input.category);
    try {
      await writeFile(path, content, { flag: "wx" }); // fails if path already exists
    } catch (error) {
      if (isFileExists(error) && attempt < MAX_ATTEMPTS) continue; // collision — recompute nextId
      throw error;
    }
    return { id, path, fields: result.value, body: content };
  }
```
   - The `bodySections` parsing (the `input.body !== undefined` block) is the same every
     attempt — compute it ONCE before the loop, reference it inside.
   - Add a small `isFileExists(error)` helper next to the existing `isFileNotFound` (in this
     file or `config/project.ts`): `error instanceof Error && "code" in error && error.code === "EEXIST"`.
   - Do NOT route `relocateArtifact`/`writeFields` through the exclusive write — they must
     keep overwrite semantics.

## Out of scope — do NOT touch
- `nextId`'s scanning logic (it's correct; the race is the unguarded write, not the scan).
- A lockfile/mutex scheme — explicitly rejected as heavier than needed.
- `next-id.ts` (the standalone `wiki next-id` command is a read-only preview; leave it).

## Verification
`bun run build && bunx tsc --noEmit && bun test tests/` — all green. New test passes.

## Test plan
Add to `tests/id-generation.test.ts` (the existing nextId/id test file) a concurrency
characterization test using a temp-vault fixture (mirror the setup already in that file):
fire two `createArtifact` of the SAME type concurrently via `Promise.all`, then assert the
two returned ids are DISTINCT and both files exist on disk. Without the fix this flakes/fails;
with it the second create retries to the next id.

## Maintenance note
The retry bound (`MAX_ATTEMPTS`) is a safety valve, not a real limit — collisions resolve in
one retry under normal contention. If creates ever throw `EEXIST` after exhausting retries,
that indicates a non-create writer is racing the directory, which is a separate bug.
