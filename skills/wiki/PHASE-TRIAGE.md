---
based-on: mattpocock/skills/engineering/triage@b8be62f
fork-rationale: Adapts triage to wiki artifact state, vault truth, and CLI repair instead of ticket queues.
---
# Phase: triage

Goal: restore a trustworthy next action when state, evidence, or scope is
unclear.

## When triage fires

- Stale session: agent starts with no active context or an expired handover.
- Context loss: compaction happened, or a new agent picked up mid-project.
- Mid-project pickup: resuming work started by a different agent or human.

## Step 1 — Read current state

```
wiki status --project <name> --with-doc
```

This is the single most important command. It returns the active PRD, slices,
decisions, handovers, and the current phase. `--with-doc` inlines the phase
guidance doc so the agent can proceed without extra reads.

## Step 2 — Search for context

```
wiki search <query> --project <name>
```

Find relevant artifacts by keyword. Use when status alone does not explain
what happened or what comes next.

## Step 3 — Inspect artifacts

```
obsidian read <prd-file>                   # full PRD with field values
obsidian read <slice-file>                 # slice with evidence and todo state
```

Read the artifacts named by status. Check for missing fields, stale values,
or contradictions.

## Step 4 — Identify and fix drift

Common problems and repairs:

- **Stale slice**: status is `planned` but the parent PRD is `in-progress`.
  The slice was never started. Either begin work or mark it blocked.
- **Missing evidence**: slice is `green` but `green_log_ref` is empty.
  Re-run `wiki green <id> --project <name>` to capture the evidence.
- **Orphan handover**: handover is `open` but the session it describes is
  finished. Close it: `obsidian property:set <handover-file> status completed`.
- **Blocked slice**: check if the blocking slice is now closed. If so, the
  block auto-clears on next status check.

## Exit criteria

Triage is done when:
- The agent has full context of the project state.
- The next slice to work on is identified.
- The correct phase route (plan/prd/slice/red/green/close) is known.

If triage reveals that scope is unclear or the original requirements have
shifted, chain to the plan (grill) phase rather than jumping straight to
implementation. See `PHASE-PLAN.md`.

Otherwise, return to the phase shown by `wiki status` after repair.
