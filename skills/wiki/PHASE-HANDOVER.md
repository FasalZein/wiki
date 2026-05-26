---
based-on: mattpocock/skills/engineering/handoff@b8be62f
fork-rationale: Keeps compact transfer notes but stores them as wiki handover artifacts with next-phase routing.
---
# Phase: handover

Goal: preserve enough context for the next agent to continue without replaying the whole session.

1. Summarize what changed and what was verified.
2. Name active PRD, slice, decision, and evidence paths.
3. State the exact next command or next phase.
4. Use `wiki handover write` for an active session or `wiki handover create` for ad-hoc transfer.
5. Close obsolete handovers once the next agent has resumed.
