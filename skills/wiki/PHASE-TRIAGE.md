---
based-on: mattpocock/skills/engineering/triage@b8be62f
fork-rationale: Adapts triage to wiki artifact state, vault truth, and CLI repair instead of ticket queues.
---
# Phase: triage

Goal: restore a trustworthy next action when state, evidence, or scope is unclear.

1. Run `wiki status --project <project> --with-doc`.
2. Inspect the active PRD, slice, decision, and handover IDs named by status.
3. Identify the first broken invariant: missing context, wrong status, absent evidence, or stale handover.
4. Repair through the narrowest CLI command available.
5. Return to the phase shown by status after the repair.
