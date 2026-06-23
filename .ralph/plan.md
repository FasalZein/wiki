# Ralph Plan: Wiki structure redesign (ADR-0036)

Build the compiled-wiki structure decided in **ADR-0036** and authored as four vault slices
(**SLICE-0071..0074**). Rationale lives in ADR-0036 and DOC-0006; each item's full spec is the
slice itself (injected as a source_doc each iteration). SLICE-0075 (summary backfill) is
DEFERRED — do NOT build it.

Order is dependency-first: the schema field, then the index that reads it, then the grouping
that sections the index, then the template cleanup.

## Items (priority order — see items.json + the injected slice for each)
1. [ ] SLICE-0071 — required `summary:` field on all 5 template schemas
2. [ ] SLICE-0072 — generate per-project `index.md` at `wiki sync`
3. [ ] SLICE-0073 — `group:` frontmatter sections the generated index
4. [ ] SLICE-0074 — strip template-bleed from all 5 templates

## Guardrails (HARD — reviving any of these FAILS the iteration)
Carried from the de-workflow pivot (ADR-0034) — still in force:
- No session state/verb, no TDD/close/red-green gates, no slice lifecycle, no mandatory
  phases, no Obsidian plugin/lock/Templater coupling, no `guidance.ts`/PHASES machinery.
- The project is deliberately LEAN. No new abstractions, config layers, plugin systems, CRUD
  wrappers, or "flexibility". These are surgical, additive changes.
- `create` stays PURE: it does NOT generate `index.md` and does NOT auto-index via qmd. The
  index is generated ONLY by `wiki sync`. The PRD↔slice backlink in create stays.
- `dedup.ts` stays advisory/non-blocking.

New-work guardrails specific to this plan:
- `summary:` is just a schema field + a rendered body line + the auto-derived `--summary`
  create flag. Do NOT build a summary-generation system. Making it required WILL break existing
  create tests/fixtures that omit it — update those fixtures to pass a summary (that is part of
  item 1, not a reason to make it optional).
- `index.md` is plain markdown (renders in CLI/GitHub/Obsidian) — NO Dataview/Bases. Generated
  at sync, idempotent overwrite, per-project granularity only (no per-kind sub-index).
- `group:` is a frontmatter field ONLY — never physical nested folders (would fight the
  path-containment guard).
- SLICE-0074 edits the template SOURCE files only (`templates/*.md`). Do NOT touch existing
  vault artifacts — cleaning those is the deferred SLICE-0075. READ existing **SLICE-0058**
  first (it stripped Templater blocks from existing files via the renderer) so you don't
  duplicate that work.
- Match surrounding code style. Mark deliberate simplifications with a `ponytail:` comment.
  NO `as any` / `@ts-ignore` / suppressed errors.

## Environment (every iteration)
- Build before testing: `bun run build`. Run the CLI as
  `KNOWLEDGE_VAULT_ROOT=/Users/tothemoon/Knowledge bun dist/cli.js <args>`.
  NEVER invoke a `wiki` on PATH — it is stale.
- Tests use TEMP vault fixtures (follow the existing `tests/` patterns). Do NOT point sync/create
  tests at the real `/Users/tothemoon/Knowledge` vault — it would mutate real data.
- `grep`/`rg` may resolve to BSD grep; use `command grep` or the Read tool.
- `timeout` is not available on macOS; don't rely on it.

## Verification (exact — run for EVERY item)
`bun run build && bunx tsc --noEmit && bun test tests/` — all green. Start from 253 passing;
items 1/2/3 ADD tests, item 4 keeps green. Item 1 also fixes any existing fixtures that now
miss the required summary.

## Quality bar
Full implementations, no stubs. ONE item per iteration. READ the injected slice (and ADR-0036)
first, then search the code to confirm current state before editing. Commit each item
separately with a descriptive message.
