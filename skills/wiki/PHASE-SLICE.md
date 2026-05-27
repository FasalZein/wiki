---
based-on: mattpocock/skills/engineering/to-issues@b8be62f
fork-rationale: Replaces issue creation with wiki slice creation while keeping thin vertical delivery guidance.
---
# Phase: slice

Goal: break a PRD into independently-deliverable vertical slices, then deliver
each through TDD.

## 1. Gather context

Work from whatever is already in the conversation context. If the user passes
an artifact reference, read it via `obsidian read`. Explore the codebase if
you haven't already — slice titles and descriptions should use the project's
domain glossary vocabulary, and respect ADRs.

## 2. Draft vertical slices

Break the PRD into **tracer bullet** slices. Each slice is a thin vertical
cut through ALL integration layers end-to-end, NOT a horizontal slice of one
layer.

- Each slice delivers a narrow but COMPLETE path through every layer (schema,
  API, UI, tests).
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over few thick ones.

Slices may be **HITL** or **AFK**. HITL slices require human interaction
(architectural decision, design review). AFK slices can be implemented and
merged without human interaction. Prefer AFK over HITL where possible.

## 3. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

## 4. Publish slices

Create slices in dependency order (blockers first) so you can reference real
IDs in the `blocked_by` field:

```
wiki create slice --project <name> --title "Short outcome description" --parent-prd <id>
```

For each slice, fill via `obsidian property:set`:

- **acceptance** — concrete, testable criteria (checkboxes).
- **todo** — implementation steps.
- **user_stories** — which user stories this addresses.
- **blocked_by** — IDs of blocking slices (if any).

## TDD state machine

Slices follow a strict status progression: `planned` → `red` → `green` → `closed`.

### Red phase

```
wiki red <id> --project <name>
```

Runs the test command. Refuses if zero test failures are detected — you must
have at least one failing test. Records the output path in `red_log_ref`.

### Green phase

```
wiki green <id> --project <name>
```

Runs tests again. Refuses unless every red-phase failure now passes with no
new regressions. Records the output path in `green_log_ref`.

### TDD exemption

When a slice has no testable behavior (pure docs, config-only):

```
obsidian property:set <slice-file> tdd_exempt true type=checkbox
obsidian property:set <slice-file> tdd_exempt_reason "Documentation-only change with no testable behavior"
```

Note: use `type=checkbox` for boolean fields — without it, Obsidian writes
`"true"` (string) instead of `true` (boolean). `tdd_exempt_reason` must be
>= 20 characters.

## Close

```
wiki close <id> --project <name>
```

Checks: all todos done, red/green evidence exists (or `tdd_exempt` is true),
acceptance criteria satisfied. Records `review_verdict`. Rejected slices
return to `green` for rework.

## Blocked slices

```
obsidian property:set <slice-file> blocked_by SLICE-034
```

Cannot transition until every `blocked_by` slice is `closed`.
