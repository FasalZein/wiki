---
name: wiki
description: "Use for wiki vault work — PRD, slice, decision, TDD, close, handover, init, doctor, migrate."
---
# /wiki

Use this skill whenever work touches the wiki vault or delivery records.

## Hard rules

1. The CLI is the only writer. Do not hand-write vault PRD, slice, decision, or handover files.
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
wiki vault doctor                          # check vault health
```

## Agent steps

1. Run `wiki status --project <project> --with-doc` to read the active phase and inline guidance.
2. If no session exists, run the requested init, plan, migration, or ad-hoc command explicitly.
3. Pick the phase route below and read its one-hop doc. Use only the matching CLI verbs.
4. Run tests or checks named by the active slice/PRD.
5. Record the state transition through the CLI (e.g. `wiki slice red`, `wiki prd publish`).
6. If the session is ending or context is switching, write a handover before stopping.
7. On resume, always start with step 1 — never assume stale context is current.

## Phase routing

- **plan**: Read `PHASE-PLAN.md` NOW. Use `wiki plan create|set|show|promote` to collect
  questions, constraints, and proposed scope.
- **prd**: Read `PHASE-PRD.md` NOW. Use `wiki prd create|set|show|publish|close`; keep
  acceptance testable.
- **slice**: Read `PHASE-SLICE.md` NOW. Use `wiki slice create|set|append|show|red|green|close`;
  keep one vertical outcome per slice.
- **triage**: Read `PHASE-TRIAGE.md` NOW. Use `wiki status`, `wiki search`, and artifact
  `show`/`set` verbs to restore truth.
- **red/green/TDD**: Load `/tdd`. Use `wiki slice red` for a failing behavior, then
  `wiki slice green` for the passing behavior.
- **close**: Verify todos, evidence, and review verdict, then run `wiki slice close` or
  `wiki prd close`.
- **handover**: Read `PHASE-HANDOVER.md` NOW. Use `wiki handover create|show|close`.
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

- Running `wiki slice green` without a prior `wiki slice red` — the CLI requires red evidence first.
- Forgetting `--with-doc` on `wiki status` — without it, you get IDs but not inline phase guidance.
- Creating slices before the PRD is published — slices reference a parent PRD that must be `ready`.
- Leaving handovers open — stale open handovers clutter triage. Close them after the next agent
  resumes.
