---
name: handoff
description: "Writes a durable session handover into the wiki vault so the next agent resumes without replaying the session. Use when ending or pausing wiki delivery work, the user asks to hand off, hand over, wrap up, or park work, or the session is close to its context limit."
---
# /handoff

A vault-native handover skill. The only output is `wiki handover` into the vault —
never a repo file, never anywhere outside the vault. Syntax: `wiki handover --help`.

## Step 1 — ground the handover in real state

Run `wiki status --project <name>` and `wiki session show` first, and re-read what
actually happened this session (gates run, artifacts created, verdicts). A handover
written from memory drifts; one written from state doesn't. Report outcomes
faithfully — failed or skipped work is exactly what the next agent must know.

## Step 2 — write behavioral notes, not a transcript

Quality bar for the content you pass to `wiki handover`:

- **Reference artifacts, don't duplicate them.** Point at IDs (PRD-NNNN, SLICE-NNNN,
  ADR-NNNN); never paste their bodies into the handover.
- **Produced**: what is durably done and verified, by ID, with gate outcomes.
- **Open**: the next concrete action per open item — what to run, not what to know.
  Include anything blocked and why, plus any user decision being waited on.
- **Decisions**: judgment calls made this session that aren't recorded elsewhere;
  if one deserves permanence, record it via `wiki create decision` first and
  reference the ID instead.
- **Suggested next skill/phase**: where the next agent should start.
- Write for an agent with zero context: no session shorthand, no unexplained
  codenames, absolute dates rather than "today".

## Step 3 — publish in one shot

Sync first so search reflects this session's writes: `wiki sync --project <name>`
(search does not re-embed on its own). Then publish with a single `wiki handover`
command — check `wiki handover --help` for flags; `-` reads a value from stdin.
Close stale open handovers once their content is absorbed.

The CLI finishes the loop itself: it advances the session phase to your
`--next-phase` and prints a delimited "next session prompt" block. Relay that
printed prompt to the user verbatim — it is what they paste into the fresh
session to resume.

Output contract: the handover lands in the vault via the `wiki` CLI — never GitHub
Issues, repo files, or anywhere else, even if another loaded skill says otherwise.
