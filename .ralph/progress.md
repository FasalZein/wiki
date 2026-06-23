# Progress

<!-- Each iteration appends here. Keep entries concise. -->

## Iter 1 — SLICE-0071 (required summary field) ✅
- Added `summary: { type: string, required: true, min: 10, max: 200 }` to all 5 template schemas (prd, slice, decision, doc, handoff), placed after `title` (after `project` for handoff).
- Rendered `{{summary}}` as a body line under the `>` metadata line in each template. summary is a schema field, so createGeneric auto-derives the `--summary` flag and store validation enforces required+min.
- Grandfather verified: `readArtifact` does NOT call `validate()` (store.ts:70), so the ~2,900 existing summary-less files keep reading fine. Enforcement is create/set only (store.ts:168 create, :265 writeFields/set).
- NOTE (max not enforced): `validate.ts` checks `min` for strings but never `max` (true for the existing `title: max 80` too). Declared `max: 200` for spec parity but did NOT add a global max check — zero acceptance-criteria payoff, regression surface across every max-declaring field. Flagged for a possible later slice.
- Fixtures: added `--summary`/`summary:` to every create/createArtifact call and exact-error `validate()` assertions across artifacts, schema, path-containment, id-generation, cli-prd/doc/decision/slice/dedup/mutate/one-shot/create-path-echo/fmt tests.
- New tests: prd renders summary line; prd create without --summary exits 1 naming summary; decision artifact stripped of summary still reads (grandfather).
- Verify: `bun run build && bunx tsc --noEmit && bun test tests/` → 256 pass, 0 fail.
