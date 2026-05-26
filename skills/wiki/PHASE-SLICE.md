---
based-on: mattpocock/skills/engineering/to-issues@b8be62f
fork-rationale: Replaces issue creation with wiki slice creation while keeping thin vertical delivery guidance.
---
# Phase: slice

Goal: define and deliver the smallest verifiable increment.

## Create a slice

```
wiki slice create --prd <id> --project <name> --title "Short outcome description"
```

Returns a slice ID (e.g. SLICE-035). Status starts at `planned`.

A slice is one tracer-bullet unit of work — vertical (touches every layer
needed for the outcome), not horizontal (one layer across many outcomes).
Acceptance criteria must be non-empty before the slice can leave `planned`.

## Field updates

```
wiki slice set <id> --field <field> <value>
wiki slice append <id> --field todo "Write integration test for sync"
```

Use `set` for scalar fields, `append` for list fields (todo, acceptance,
user_stories).

## TDD state machine

Slices follow a strict status progression: `planned` -> `red` -> `green` -> `closed`.

### Red phase

```
wiki slice red <id>
```

Runs the test command defined in the slice or project config. Refuses if zero
test failures are detected — you must have at least one failing test that
proves the behavior is missing. On success, records the output path in
`red_log_ref`.

### Green phase

```
wiki slice green <id>
```

Runs the test command again. Refuses unless every test that failed in the red
log now passes AND there are no new regressions. Records the output path in
`green_log_ref`.

### TDD exemption

When a slice has no testable behavior (pure docs, config-only), set both fields:

```
wiki slice set <id> --field tdd_exempt true
wiki slice set <id> --field tdd_exempt_reason "Documentation-only change with no testable behavior"
```

`tdd_exempt_reason` must be >= 20 characters. Exempt slices skip red/green and
go directly from `planned` to close review.

## Close

```
wiki slice close <id>
```

Loads review-phase skills, checks: all todos done, red/green evidence exists
(or `tdd_exempt` is true with a reason), acceptance criteria satisfied. Records
`review_verdict` (pass, pass-with-notes, or reject). Rejected slices return to
`green` for rework.

## Blocked slices

```
wiki slice set <id> --field blocked_by SLICE-034
```

Status becomes `blocked`. Cannot transition until every `blocked_by` slice is
`closed`. Use `wiki slice show <id>` to inspect current block state.
