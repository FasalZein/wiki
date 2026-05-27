---
based-on: mattpocock/skills/engineering/handoff@b8be62f
fork-rationale: Keeps compact transfer notes but stores them as wiki handover artifacts with next-phase routing.
---
# Phase: handover

Goal: preserve enough context for the next agent to continue without
replaying the whole session.

## When to write a handover

- Session is ending (user signs off, time limit approaching).
- Context switch: moving to a different project or unrelated task.
- Before compaction: save state before the conversation is trimmed.
- Voluntary checkpoint: the work is at a clean boundary worth recording.

## Create a handover

```
wiki handover --project <name>
```

Auto-fills from CLI session state: active PRD, in-flight slices, current
phase, decisions made this session. Returns a handover ID (e.g. HANDOVER-0012).

Override auto-filled fields with flags:

```
wiki handover --project <name> --phase slice --active-prd PRD-003 \
  --active-slice SLICE-035 --produced "Implemented sync command" \
  --open "Need to add error handling for offline mode"
```

## Required content

Fill the following sections (auto-filled fields can be overridden):

- **produced** — what this session created or changed. Reference artifacts by
  ID, not by restating their content.
- **decisions_made** — links to any decisions recorded this session.
- **active_prd / active_slices** — auto-populated from session state.
- **open** — open questions and concrete next steps. Name the next gate, the
  next artifact to write, or the next decision to surface.
- **suggested_skills** — skills the next agent should load on resume.

A handover is a pointer, not a re-explanation. If a slice describes the work,
link to it — do not copy its content into the handover.

## Writing quality handovers

A handover is the authoritative specification that the next agent works from.
The artifact fields and body are the contract — prior conversation context is
background, not the spec.

### Durability over precision

The handover may sit unread for days. The codebase will change. Write so it
stays useful even as files are renamed, moved, or refactored.

- **Do** describe interfaces, types, and behavioral contracts.
- **Do** name specific types, function signatures, or config shapes.
- **Don't** reference file paths — they go stale.
- **Don't** reference line numbers.
- **Don't** assume the current implementation structure will remain the same.

### Behavioral, not procedural

Describe **what** the system should do, not **how** to implement it. The next
agent will explore the codebase fresh and make its own decisions.

- **Good:** "The `SkillConfig` type should accept an optional `schedule` field
  of type `CronExpression`"
- **Bad:** "Open src/types/skill.ts and add a schedule field on line 42"
- **Good:** "Running `wiki status` should show slices grouped by PRD"
- **Bad:** "Add a switch statement in the status handler function"

### Complete next steps

The next agent needs to know where to start. The `open` field must have
concrete, actionable items — not "continue working on the feature."

### Explicit scope boundaries

State what is NOT in scope for the next session. This prevents the next agent
from gold-plating or making assumptions about adjacent work.

### Reference, don't duplicate

A handover is a pointer, not a re-explanation. If a PRD describes the work,
link to it by ID — do not copy its content into the handover. If a slice has
the acceptance criteria, reference the slice. Duplication drifts.

## Examples

### Good handover (open field)

```
Next: wiki red SLICE-NNN --project wiki-v2. Test command is
`bun test tests/cli-sync.test.ts`. Expected failure: sync should detect
when a QMD collection is stale and re-embed. After green, the next slice
(search result ranking) is unblocked. PRD-003 has 2/5 slices closed.
```

### Bad handover (open field)

```
Continue working on the sync feature. There are some tests to write.
```

This is bad because: no specific gate named, no test command, no expected
behavior, no connection to the broader PRD progress.

## Review

```
obsidian read <handover-file>              # display the full handover artifact
```

## Session state

```
wiki session show                          # current session: active project, phase, artifacts touched
```

Use this to verify the handover captures everything before closing the session.

## Close obsolete handovers

When the next agent has resumed and confirmed context, close the handover
by setting its status directly:

```
obsidian property:set <handover-file> status completed
```

Stale open handovers are flagged by `wiki status` during triage.
