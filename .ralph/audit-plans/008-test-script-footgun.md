# Plan 008 — Fix the `test` script footgun

Target commit: `5dbf09f`.

## Why
`package.json:12` is `"test": "bun test"`, but README.md and the project CLAUDE.md both warn:
"ALWAYS scope to `tests/` — a bare `bun test` descends into `qmd/`." So the canonical
`bun run test` / `npm test` runs the exact command the docs flag as broken (it descends into
the bundled `qmd/` directory and runs unrelated tests).

## What to change
In `package.json`, change line 12:
```json
"test": "bun test",
```
to:
```json
"test": "bun test tests/",
```

## Out of scope — do NOT touch
- Any other script (`build`, `typecheck` are correct).
- Do NOT add CI/lint/format tooling — explicitly out of scope (the project is deliberately lean).

## Verification
- `bun run test` — now runs only `tests/`, all green (238+), does NOT descend into `qmd/`.
- `bun run build && bunx tsc --noEmit` — still clean.

## Test plan
None — this is a one-line script fix. The verification above IS the check.

## Maintenance note
The canonical local gate is `bun run build && bunx tsc --noEmit && bun test tests/`. The
`test` script now matches the documented gate, so `bun run test` is safe to wire into CI later.
