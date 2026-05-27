# Writing Quality Handovers

A handover is the authoritative specification that the next agent works from.
The artifact fields and body are the contract — prior conversation context is
background, not the spec. This is the wiki equivalent of Matt Pocock's
`AGENT-BRIEF.md`.

## Principles

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

- **Good:** "Next gate is `wiki red SLICE-037`. Test command:
  `bun test tests/cli-sync.test.ts`. Expected failure: sync should detect
  stale collections."
- **Bad:** "Continue with the sync feature."

### Explicit scope boundaries

State what is NOT in scope for the next session. This prevents the next agent
from gold-plating or making assumptions about adjacent work.

### Reference, don't duplicate

A handover is a pointer, not a re-explanation. If a PRD describes the work,
link to it by ID — do not copy its content into the handover. If a slice has
the acceptance criteria, reference the slice. Duplication drifts.

## Filling the fields

- **produced** — what this session created or changed. List artifact IDs, not
  prose descriptions of what's in them.
- **decisions_made** — links to any ADRs recorded this session.
- **active_prd / active_slices** — auto-populated from session state, verify
  these are correct.
- **open** — the single most important field. Name the next gate, the next
  artifact to write, or the next decision to surface. Be specific.
- **suggested_skills** — skills the next agent should load on resume.

## Examples

### Good handover (open field)

```
Next: wiki red SLICE-037 --project wiki-v2. Test command is
`bun test tests/cli-sync.test.ts`. Expected failure: sync should detect
when a QMD collection is stale and re-embed. After green, SLICE-038
(search result ranking) is unblocked. PRD-003 has 2/5 slices closed.
```

### Bad handover (open field)

```
Continue working on the sync feature. There are some tests to write.
```

This is bad because: no specific gate named, no test command, no expected
behavior, no connection to the broader PRD progress.
