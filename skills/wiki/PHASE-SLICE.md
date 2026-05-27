---
based-on: mattpocock/skills/engineering/to-issues@b8be62f
fork-rationale: Replaces issue creation with wiki slice creation while keeping thin vertical delivery guidance.
---
# Phase: slice

Goal: define and deliver the smallest verifiable increment.

## Create a slice

```
wiki create slice --project <name> --title "Short outcome description" --parent-prd <id>
```

Returns a slice ID (e.g. SLICE-035). Status starts at `planned`.

A slice is one tracer-bullet unit of work — vertical (touches every layer
needed for the outcome), not horizontal (one layer across many outcomes).
Acceptance criteria must be non-empty before the slice can leave `planned`.

## Field updates

Use Obsidian primitives to read and update fields:

```
obsidian property:set <slice-file> <field> <value>
obsidian read <slice-file>
```

Use `property:set` for scalar fields. For list fields (todo, acceptance,
user_stories), use `obsidian property:set` with the list value.

## TDD state machine

Slices follow a strict status progression: `planned` -> `red` -> `green` -> `closed`.

### Red phase

```
wiki red <id> --project <name>
```

Runs the test command defined in the slice or project config. Refuses if zero
test failures are detected — you must have at least one failing test that
proves the behavior is missing. On success, records the output path in
`red_log_ref`.

### Green phase

```
wiki green <id> --project <name>
```

Runs the test command again. Refuses unless every test that failed in the red
log now passes AND there are no new regressions. Records the output path in
`green_log_ref`.

### TDD exemption

When a slice has no testable behavior (pure docs, config-only), set both fields:

```
obsidian property:set <slice-file> tdd_exempt true type=checkbox
obsidian property:set <slice-file> tdd_exempt_reason "Documentation-only change with no testable behavior"
```

Note: use `type=checkbox` for boolean fields — without it, Obsidian writes `"true"` (string) instead of `true` (boolean).

`tdd_exempt_reason` must be >= 20 characters. Exempt slices skip red/green and
go directly from `planned` to close review.

## Close

```
wiki close <id> --project <name>
```

Loads review-phase skills, checks: all todos done, red/green evidence exists
(or `tdd_exempt` is true with a reason), acceptance criteria satisfied. Records
`review_verdict` (pass, pass-with-notes, or reject). Rejected slices return to
`green` for rework.

## Blocked slices

```
obsidian property:set <slice-file> blocked_by SLICE-034
```

Status becomes `blocked`. Cannot transition until every `blocked_by` slice is
`closed`. Use `obsidian read <slice-file>` to inspect current block state.
