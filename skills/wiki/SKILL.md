---
name: wiki
description: "Use for wiki vault work — PRD, slice, decision, TDD, close, handover, init, doctor, migrate."
---
# /wiki

Use this skill whenever work touches the wiki vault or delivery records.

## Hard rules

1. Use the CLI for workflow transitions (create, red, green, close, handover). Use Obsidian primitives (`obsidian property:set`, `obsidian read`, `obsidian eval`) for field-level reads and writes.
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

- **plan**: Read `PHASE-PLAN.md` NOW. Plans are vault notes — create and edit them
  directly in Obsidian. No CLI verbs for plans.
- **prd**: Read `PHASE-PRD.md` NOW. Use `wiki create prd` to create; use
  `obsidian property:set` to fill fields; agents set status directly.
- **slice**: Read `PHASE-SLICE.md` NOW. Use `wiki create slice` to create; use
  `obsidian property:set` for fields; `wiki red/green/close` for TDD gates.
- **triage**: Read `PHASE-TRIAGE.md` NOW. Use `wiki status`, `wiki search`, and
  `obsidian read` to restore truth.
- **red/green/TDD**: Load `/tdd`. Use `wiki red` for a failing behavior, then
  `wiki green` for the passing behavior.
- **close**: Verify todos, evidence, and review verdict, then run `wiki close`.
- **handover**: Read `PHASE-HANDOVER.md` NOW. Use `wiki handover`.
- **query**: Use `obsidian eval` to run Dataview queries against vault content when you
  need to aggregate or filter artifacts (e.g. list all open slices, count PRDs by status).

## Phase progression

Normal flow: plan -> prd -> slice -> red -> green -> close -> handover.
Not every project needs plan. Triage can fire at any point when context is lost.
A PRD can have many slices; each slice goes through red/green/close independently.

## Admin routing

- **vault init/doctor/sync/bless**: Read `ADMIN-VAULT.md` NOW before running admin commands.
- **migrate**: Read `ADMIN-MIGRATION.md` NOW before moving v1 content into v2.
- **bases**: Use Obsidian Bases views for tabular project dashboards (PRD status boards,
  slice progress grids, decision logs). Bases views are configured in the vault, not
  through the CLI. Check them in Obsidian to get a visual overview of project state.

## Common pitfalls

- Running `wiki green` without a prior `wiki red` — the CLI requires red evidence first.
- Forgetting `--with-doc` on `wiki status` — without it, you get IDs but not inline phase guidance.
- Creating slices before the PRD is published — slices reference a parent PRD that must be `ready`.
- Leaving handovers open — stale open handovers clutter triage. Close them after the next agent
  resumes.
