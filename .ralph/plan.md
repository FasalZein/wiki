# Ralph Plan: Wiki CLI — audit fixes (from /improve)

Eight findings from a vetted read-only audit (`/improve`, standard depth, 4 parallel
auditors) of the de-workflowed wiki CLI. Each finding was confirmed against the cited code.
Detailed, self-contained per-item plans live in `.ralph/audit-plans/NNN-*.md` — the executor
MUST read its item's plan file before changing anything. Plans target commit `5dbf09f`.

Order is risky-first: security + data-integrity, then a correctness bug, then consolidation,
then deletion, then a one-liner.

## Items (priority order — see items.json + the plan file per item)
1. [ ] Path-traversal containment (`--project` + `id`) — `001-path-containment.md`
2. [ ] Supersede rollback gap — `002-supersede-rollback.md`
3. [ ] `nextId` TOCTOU race — `003-nextid-race.md`
4. [ ] qmd `JSON.parse` hardening + test — `004-qmd-parse-hardening.md`
5. [ ] `null`-field validation bug — `005-null-field-validate.md`
6. [ ] Project-resolution consolidation — `006-project-resolution-consolidation.md`
7. [ ] De-workflow dead-code removal — `007-deworkflow-dead-code.md`
8. [ ] `test` script footgun — `008-test-script-footgun.md`

## Guardrails (HARD — reviving any of these FAILS the iteration)
Do NOT reintroduce anything the de-workflow pivot (ADR-0034) stripped:
- No session state/verb, no TDD/close/red-green gates, no slice lifecycle, no mandatory
  phases, no `--next-phase`/`next_command`, no blocking-dedup-as-default, no Obsidian
  plugin/lock/Templater coupling, no `guidance.ts`/PHASES machinery (these no longer exist).
- The project is deliberately LEAN. Do NOT add abstractions, config layers, plugin systems,
  CRUD wrappers, lint/format/CI tooling, or "flexibility". The fixes are surgical: validate
  inputs, fix rollback/race/parse/null bugs, consolidate duplication, delete dead code. NO
  new features or structure.
- `dedup.ts` is advisory/non-blocking BY DESIGN — do not make it block. `create` does NOT
  auto-index via qmd BY DESIGN — do not add it. The PRD↔slice backlink in create IS allowed.
- Artifacts live in the vault (`/Users/tothemoon/Knowledge`, project `wiki-v2`), never the
  repo / GitHub Issues / `docs/adr/` / temp dirs.
- Match the surrounding code's style. Mark deliberate simplifications with a `ponytail:`
  comment where the plan shows one. NO `as any` / `@ts-ignore` / suppressed errors.

## Environment (every iteration)
- Build before testing: `bun run build`. Run the CLI as
  `KNOWLEDGE_VAULT_ROOT=/Users/tothemoon/Knowledge bun dist/cli.js <args>`.
  NEVER invoke a `wiki` on PATH — it is stale.
- `grep`/`rg` may resolve to BSD grep; use `command grep` or the Read tool.
- `timeout` is not available on macOS; don't rely on it.

## Verification (exact — run for EVERY item)
`bun run build && bunx tsc --noEmit && bun test tests/` — all green (238+ pass; items 1/3/4/5
ADD tests). tsc is the safety net for the deletion item (7) — fix every reference it flags.

## Quality bar
Full implementations, no stubs. ONE item per iteration. READ the item's plan file first, then
search the code to confirm it still matches before editing. Each plan has an escape hatch
("if X, STOP and report") — honor it. Commit each item separately with a descriptive message.
