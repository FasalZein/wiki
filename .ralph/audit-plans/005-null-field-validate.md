# Plan 005 — Treat a `null` frontmatter value as absent, not a type mismatch

Target commit: `5dbf09f`. If `src/schema/validate.ts` has drifted from the excerpt below,
STOP and report.

## Why
`validate` checks `value === undefined` for required fields, but a blank key in
Obsidian-authored frontmatter (`foo:` with no value) round-trips through gray-matter as
`null`, not `undefined`. `matchesType` has no `null` branch, so it returns `false` and the
field reports "type mismatch". Because `setFields`/`writeFields` (`store.ts`) re-validate the
ENTIRE existing field set on every write, one unrelated blank optional field makes any later
`wiki set`/`wiki block`/`wiki supersede` fail. `wiki validate` shows the same misleading
"type mismatch" instead of "this optional field is empty".

## Current code (`src/schema/validate.ts:9-18`)
```ts
  for (const field of schema.fields) {
    const value = input[field.name];
    if (field.required && value === undefined) {
      errors.push({ field: field.name, reason: "required", expected: field.type });
      continue;
    }
    if (value !== undefined && !matchesType(field, value)) {
      errors.push({ field: field.name, reason: "type mismatch", expected: field.type });
      continue;
    }
    ...
```

## What to change (in `src/schema/validate.ts`)
Coalesce `null` to `undefined` at the top of the loop so a blank value is treated as
"absent": blank required → "required" error (correct), blank optional → passes.
```ts
  for (const field of schema.fields) {
    const value = input[field.name] ?? undefined; // ponytail: gray-matter yields null for a blank key; treat blank as absent
    if (field.required && value === undefined) {
```
`?? undefined` converts only `null`/`undefined` to `undefined` (it does NOT touch `0`,
`false`, or `""`), so the rest of the loop is unaffected.

Note on the return value: `return { ok: true, value: input }` returns `input` unchanged, so a
`null` field is preserved on disk (re-serialized as `foo:` by `matter.stringify`). That's
fine — this change only fixes classification, it does not strip the field.

## Out of scope — do NOT touch
- `matchesType` (no need to add a null branch — the coalesce handles it upstream).
- The required/enum/min-length/pattern checks (unchanged).
- Do NOT start stripping null fields from the written output — preserving them is correct.

## Verification
`bun run build && bunx tsc --noEmit && bun test tests/` — all green. New tests pass.

## Test plan
Add to `tests/schema.test.ts` (the existing validate test file):
- a schema with an OPTIONAL field set to `null` in the input → `validate` returns `ok: true`.
- the same field marked REQUIRED and set to `null` → returns `ok: false` with reason
  `"required"` (NOT `"type mismatch"`).
Then a round-trip integration test in `tests/artifacts.test.ts` (temp-vault): create an
artifact, hand-write a blank optional key into its frontmatter (or set it to null), then call
`setFields` to change an UNRELATED field → succeeds (today it throws "type mismatch").

## Maintenance note
The invariant: a blank/`null` frontmatter value means "field absent", everywhere validation
runs. Any future validator branch that inspects a value must tolerate the coalesced
`undefined` rather than re-introducing a `null`-specific path.
