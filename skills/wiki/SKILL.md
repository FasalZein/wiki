---
name: wiki
description: "Manages wiki vault delivery workflow — PRDs, slices, decisions, TDD gates, handovers. Use when work touches the wiki vault, user asks to create/update/close delivery artifacts, or context needs restoring via triage."
---
# /wiki

Use this skill whenever work touches the wiki vault or delivery records.

## Hard rules

1. Use the CLI for workflow transitions (`create`, `red`, `green`, `close`, `handover`). Use Obsidian primitives (`obsidian property:set`, `obsidian read`, `obsidian eval`) for field-level reads/writes and PRD status changes.
2. Resolve project context before acting: `wiki status --project <name>` or `wiki session show`.
3. Follow the current phase exactly; do not skip TDD, review, close, or handover gates.
4. Keep generated skill source in this repo only; do not install or symlink into `~/.pi`.
5. When details matter, read the referenced one-hop doc now, then return to this workflow.
6. Obsidian must be running. The vault relies on Obsidian for rendering, Dataview queries,
   and Bases views. If Obsidian is not open, start it before running wiki commands.
7. Domain terms used in any artifact must exist in domain-language.md. Define before using.

## Quick reference

```
wiki status --project <name> --with-doc    # orientation: phase, active artifacts, inline guidance
wiki session show                          # current session context
wiki search <query> --project <name>       # find artifacts by keyword
wiki doctor                                # check vault health
```

## CLI surface

Workflow gates: `create`, `red`, `green`, `close`, `handover`.
Read/query: `status`, `search`, `session show`.
Admin: `validate`, `next-id`, `doctor`, `sync`, `vault`, `project`.
Field reads/writes: use `obsidian property:set`, `obsidian read`, `obsidian eval` directly.

## Agent steps

1. Run `wiki status --project <project> --with-doc` to read the active phase and inline guidance.
2. If no session exists, run the requested init, plan, migration, or ad-hoc command explicitly.
3. Pick the phase route below and read its one-hop doc. Use only the matching commands.
4. Run tests or checks named by the active slice/PRD.
5. Record the state transition through the CLI (e.g. `wiki red`, `wiki close`).
6. If the session is ending or context is switching, write a handover before stopping.
7. On resume, always start with step 1 — never assume stale context is current.

## Phase routing

Normal flow: plan (grill) → prd → slice → red → green → close → handover.
Triage can fire at any point when context is lost; it chains back to plan if scope
needs re-establishing. Not every project needs the plan/grill phase — skip it when
scope is already clear. A PRD can have many slices; each slice goes through
red/green/close independently.

- **plan (grill)**: Read `PHASE-PLAN.md` NOW. Grill the user with focused questions,
  record ADRs via `wiki create decision`, update `domain-language.md`.
- **prd**: Read `PHASE-PRD.md` NOW. Use `wiki create prd` to create; use
  `obsidian property:set` to fill fields. Close PRDs via
  `obsidian property:set <prd-file> status closed` (not `wiki close`).
- **slice**: Read `PHASE-SLICE.md` NOW. Use `wiki create slice` to create; use
  `obsidian property:set` for fields; `wiki red/green/close` for TDD gates.
- **triage**: Read `PHASE-TRIAGE.md` NOW. Use `wiki status`, `wiki search`, and
  `obsidian read` to restore truth.
- **red/green/TDD**: Read `PHASE-SLICE.md` NOW for the TDD gate workflow. For
  test-writing philosophy (what makes a good test), also consider loading `/tdd`.
  The gates are `wiki red` and `wiki green`.
- **close (slice)**: Run `wiki close <id> --project <name>` after verifying todos,
  evidence, and review verdict. Rejected slices return to `green`.
- **close (PRD)**: Run `obsidian property:set <prd-file> status closed` after
  verifying all linked slices are closed.
- **handover**: Read `PHASE-HANDOVER.md` NOW. Use `wiki handover`.
- **query**: Use `obsidian eval` to run Dataview queries against vault content when you
  need to aggregate or filter artifacts (e.g. list all open slices, count PRDs by status).

Do NOT invoke `/grill-with-docs`, `/to-prd`, `/to-issues`, `/handoff`, or `/triage`
directly from wiki context — those skills write to GitHub Issues, `docs/adr/`, or OS
temp dirs. Use the PHASE-*.md flow inside `/wiki` instead; the phase docs are the
wiki-medium versions of those skills.

## Admin routing

- **vault init/doctor/sync/bless**: Read `ADMIN-VAULT.md` NOW before running admin commands.

## Common pitfalls

- Running `wiki green` without a prior `wiki red` — the CLI requires red evidence first.
- Forgetting `--with-doc` on `wiki status` — without it, you get IDs but not inline phase guidance.
- Creating slices before the PRD is published — slices reference a parent PRD that must be `ready`.
- Leaving handovers open — stale open handovers clutter triage. Close them after the next agent
  resumes.
- Trying `wiki close` on a PRD — PRDs are closed via `obsidian property:set`, not the CLI.
  `wiki close` is for slices only.
- Bases views are configured in Obsidian, not through the CLI. Check them in Obsidian
  for tabular project dashboards (PRD status boards, slice progress grids, decision logs).
