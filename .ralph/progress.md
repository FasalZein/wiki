# Progress

<!-- Each iteration appends here. Keep entries concise. -->

## Iteration 1 — Item 1: PRD↔slice backlink (SLICE-0054)
- Added `backlinkParentPrd` in src/cli/verbs/create.ts: after a slice with --parent-prd
  is created, appends its id to the parent PRD's `slices` link_list via store `setField`
  (NOT Obsidian — that layer is gone). Dedup-safe (skips if already present),
  create-if-absent (setField writes whether or not the field existed). Runs inside
  createWithSupersede's rollback try block, so a bad parent PRD rolls back the slice.
- Imported `setField` into create.ts.
- Tests (tests/cli-slice.test.ts): two slices append without clobbering; PRD lacking
  `slices` gains it. Full suite 238 pass, tsc/build clean.
- Files: src/cli/verbs/create.ts, tests/cli-slice.test.ts

## Iteration 2 — Item 2: Trim templates/handoff.md to de-workflowed schema
- Removed workflow-era schema fields next_phase/active_prd/active_slices/suggested_skills;
  trimmed phase enum to [plan, prd, slice, handoff, ad-hoc] (dropped red/green/review/close).
- Dropped the Templater `<%* … %>` HTML block, the `→ next: {{next_phase}}` banner suffix,
  the "Active context" section, and the "Suggested skills" section. Kept durable fields
  (id/aliases/project/session_date/phase/decisions_made/status/created) + produced/open/
  pointers/sensitive-data body.
- Updated tests/schema.test.ts fully-populated-input case to the trimmed schema (phase:slice,
  no dropped fields). 238 pass, tsc/build clean.
- Files: templates/handoff.md, tests/schema.test.ts
