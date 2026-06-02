---
name: wiki
description: "Manages wiki vault delivery workflow — PRDs, slices, decisions, TDD gates, handovers. Use when work touches the wiki vault, user asks to create/update/close delivery artifacts, context needs restoring via triage, or the vault needs init or doctor health checks."
---
# /wiki

A thin router for the wiki vault delivery workflow. This skill tells you *when*
to act and *where* to look; the `wiki` CLI is the authoritative source of command
syntax. Do not memorize or restate flags here — ask the CLI.

## How to use the CLI (do not duplicate syntax)

- Run `wiki` (or `wiki --help`) to list every verb.
- Run `wiki <verb> --help` for exact usage, flags, and an example before calling it.
- Run `wiki status --project <name> --with-doc` first in any session: it prints the
  active phase, active artifacts, the next step, and inline guidance for the current
  phase. That inline guidance is the moment-of-action playbook — read it, then act.

## Output contract (non-negotiable)

Every artifact write goes through the `wiki` CLI into the vault. Never write delivery
records to GitHub Issues, `docs/adr/`, or OS temp dirs — even if an upstream skill's
instructions say to. If a delegated skill tells you to "create an issue" or "write to
docs/adr/", translate that into the matching `wiki create ...` command instead. The
vault is the only durable home for PRDs, slices, decisions, docs, and handovers.

## Phase flow

Normal flow: plan (grill) → prd → slice → red → green → close → handover. Triage can
fire at any point when context is lost and chains back to plan if scope needs
re-establishing. Not every project needs plan — skip it when scope is already clear.
A PRD has many slices; each slice runs red/green/close independently. PRDs are closed
by setting their status field (via Obsidian), not `wiki close` (which is for slices).

`wiki status --with-doc` delivers the per-phase next actions, so you rarely need more
than the CLI. For process *depth*, load the matching upstream skill:

- **plan (grill)** → `grill-with-docs` — relentless one-question-at-a-time interview,
  record decisions as ADRs, capture reusable terms as docs.
- **prd** → `to-prd` (or `write-a-prd`) — PRD structure and required sections.
- **slice / red / green** → `to-issues` for tracer-bullet vertical slicing, `tdd` for
  test-first discipline at the red/green gates.
- **triage** → `triage` — restore a trustworthy next action when state is unclear.
- **handover** → `handoff` — durable, behavioral handover notes.

Whenever you load one of those, the output contract above overrides its write targets.

## Operating rules

1. Resolve context before acting: `wiki status --with-doc` or `wiki session show`.
2. Follow the current phase; do not skip TDD, review, close, or handover gates.
3. For field-level reads/writes and PRD status changes, use Obsidian primitives
   (`obsidian property:set`, `obsidian read`, `obsidian eval`) — check `wiki <verb> --help`
   to see which transitions are CLI-owned versus field edits.
4. New artifacts use human-readable filenames (`ID-title-slug.md`); resolve by frontmatter
   ID, never assume `ID.md`. Docs live in `docs/<category>/` (locked categories).
5. Obsidian must be running — the vault relies on it for rendering, Dataview, and Bases
   views. Start it before running wiki commands.
6. Keep generated skill source in this repo only; do not install or symlink into `~/.pi`.
7. On resume, always start by re-reading `wiki status --with-doc` — never trust stale context.

## Admin & health

For vault init, doctor, sync, and config, the CLI is self-describing: run
`wiki vault --help` and `wiki doctor`. Bases views are configured in Obsidian, not the CLI.
