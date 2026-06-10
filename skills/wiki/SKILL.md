---
name: wiki
description: "Manages wiki vault delivery workflow — PRDs, slices, decisions, TDD gates, handovers. Use when work touches the wiki vault, user asks to create/update/close delivery artifacts, context needs restoring via triage, or the vault needs init or doctor health checks."
---
# /wiki

A thin router for vault delivery work. It tells you *when* to act and *which*
skill to load; the `wiki` CLI owns all command syntax. Never restate flags here —
ask the CLI.

## Start here (every session)

1. `wiki status --with-doc` (add `--project <name>` if not in the repo) — prints the
   active phase, artifacts, next step, and the moment-of-action guidance for that phase.
   No session yet? Run `wiki session start --project <name>`. A new session starts in
   `ad-hoc` (no enforced workflow); set a phase with `wiki session set phase <plan|prd|slice|triage>`
   (or `wiki session start --phase <phase>`), then rerun step 1 to get phase guidance.
2. `wiki <verb> --help` — exact usage/flags/example before any call. `wiki --help` lists verbs.
3. Do what the phase guidance says. On resume, always re-read step 1 — never trust stale context.

Doing vault setup or a health check, not delivery work? Skip the phase flow and run
`wiki vault --help` or `wiki doctor` — admin commands are self-describing.

## Output contract (non-negotiable)

Every artifact write goes through the `wiki` CLI into the vault — never GitHub Issues,
`docs/adr/`, or OS temp dirs, even when a loaded skill says to. "Create an issue" becomes
the matching `wiki create ...`. The vault is the only home for PRDs, slices, decisions,
docs, and handovers. This overrides any upstream skill you load.

Creation is one-shot: pass the authored body via `--body -` (stdin) so the artifact is
complete in a single command — `obsidian create` is never used. Obsidian is for later
field edits only (`property:set`/`read`/`eval`).

## Phase routing

Flow: plan (grill) → prd → slice → red → green → close → handover. A PRD has many slices;
each runs red → green → close on its own. Triage fires whenever state is unclear and
chains back to plan if scope needs re-establishing. Skip plan when scope is already clear.

The phase guidance from step 1 names the upstream skill to load for process depth
(most phases have one; `ad-hoc` has none — it just routes you to set a phase):
plan→`grill-with-docs`, slice/red/green→`to-slices` + `tdd`,
triage→`triage`, handover→`handoff`. Load it only for the phase you're in.
(prd is vault-native — no upstream skill; the phase doc carries the method.)

## Rules that the CLI won't tell you

- Field edits and PRD status changes use Obsidian (`obsidian property:set`/`read`/`eval`),
  not the CLI. `wiki close` is for slices; close a PRD by setting its status field.
- Resolve artifacts by frontmatter ID, never assume `ID.md` (filenames are `ID-title-slug.md`).
  Docs live only in the locked `docs/<category>/` folders (architecture, research, runbooks,
  specs, notes, legacy) — never invent a new folder; an unfit doc goes in the closest locked
  category. `wiki doctor` flags any rogue folder or loose file under `docs/`.
- Obsidian must be running — the vault depends on it for rendering, Dataview, and Bases views.
- Don't skip TDD/review/close/handover gates.
