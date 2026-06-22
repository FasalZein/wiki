# Ralph Plan: Wiki CLI — finish-line cleanup

The wiki CLI rewrite is **complete** (de-workflowed config-driven artifact store +
qmd recall, 17 verbs, 236 tests green, tsc/build clean). A full read-only scan of
code + the wiki-v2 vault found only a small set of genuinely-open, pivot-aligned
items. This loop closes them. **It is short by design — 3 items, not an open-ended build.**

## Guardrails (HARD — reviving any of these FAILS the iteration)

Do NOT reintroduce anything the de-workflow pivot stripped:
- No session state/verb, no close/TDD gates, no red/green, no `--next-phase`,
  no `next_command`, no blocking-dedup-as-default, no Obsidian plugin/lock/Templater
  coupling, no `src/cli/guidance.ts` / PHASES machinery (these no longer exist).
- **"create stays pure"** means create does NOT trigger qmd indexing. It says nothing
  about cross-artifact frontmatter — the PRD↔slice backlink (item 1) is a cheap local
  frontmatter write and IS allowed.
- Artifacts live in the vault (`/Users/tothemoon/Knowledge`, project `wiki-v2`), never
  the repo, GitHub Issues, `docs/adr/`, or temp dirs.

## Environment (every iteration)

- Build before testing: `bun run build`. Run the CLI as
  `KNOWLEDGE_VAULT_ROOT=/Users/tothemoon/Knowledge bun dist/cli.js <args>`.
  NEVER invoke a `wiki` on PATH — it is stale.
- `grep` is aliased (and `rg` may resolve to grep); use `command grep` or the Grep tool.

## Items (priority order — riskiest first)

1. [ ] **PRD↔slice backlink (SLICE-0054).** Slices carry `parent_prd` and `create`
   derives `--parent-prd`, but `slices` sits in create's excluded set so the parent
   PRD's `slices` list stays empty forever. After `create slice --parent-prd PRD-xxxx`
   succeeds, append the new slice ID to that PRD's `slices` frontmatter — comma-safe,
   no duplicates, create the field if absent — using the SAME list-write path
   `wiki block` uses for `blocked_by` (`src/artifacts/store.ts`, `setFields`).
   ⚠ The slice's acceptance text says "via the Obsidian processFrontMatter path" —
   that layer was REMOVED in the pivot; use the current store path, not Obsidian.
   Test (temp-vault fixture): two slices append to the parent PRD without clobbering;
   a PRD lacking `slices` gains it.

2. [ ] **Trim `templates/handoff.md` to the de-workflowed schema.** Drop workflow-era
   fields (`next_phase`, `active_prd`, `active_slices`, `suggested_skills`), remove
   `red/green/review/close` from the `phase` enum, drop the `phase → next` banner and
   the Templater `<%* … %>` block. Keep durable fields (id/project/session_date/status/
   created + produced/open/pointers/decisions_made). No code reads the dropped fields
   (verified), so this is template-only. `wiki create handoff` + `cli-hook` tests pass.

3. [ ] **Reconcile stale vault slice statuses.** Set slices that are verifiably shipped
   but still read `planned`/`green` to `closed` via
   `wiki set <id> status closed --project wiki-v2` (candidates: 0050, 0057, 0059, 0060,
   0069, 0070 — confirm each against the code that implements it before closing).
   Do NOT touch the obsolete pre-pivot slices (session/gate/obsidian/guidance).

## Verification (exact)

`bun run build && bunx tsc --noEmit && bun test tests/`  — all green (236+ pass).
For vault writes: the touched artifacts must `wiki validate` clean.

## Quality bar

Full implementations, no stubs. ONE item per iteration. Search before assuming
anything is unimplemented. Commit each item separately (vault changes commit inside
`/Users/tothemoon/Knowledge`).
