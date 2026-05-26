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
wiki handover create --project <name>
```

Auto-fills from CLI session state: active PRD, in-flight slices, current
phase, decisions made this session. Returns a handover ID (e.g. HANDOVER-0012).

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

## Review

```
wiki handover show <id>        # display the full handover artifact
```

## Session state

```
wiki session show              # current session: active project, phase, artifacts touched
```

Use this to verify the handover captures everything before closing the session.

## Close obsolete handovers

When the next agent has resumed and confirmed context, close the handover:

```
wiki handover close <id>
```

Status moves from `open` to `completed`. Stale open handovers are flagged by
`wiki status` during triage.
