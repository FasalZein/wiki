---
name: wiki
description: Use for wiki vault work: PRD, slice, decision, TDD, close, handover, init, doctor, migrate.
---
# /wiki

Use this skill whenever work touches the wiki vault or delivery records.

## Hard rules

1. The CLI is the only writer. Do not hand-write vault PRD, slice, decision, or handover files.
2. Resolve project context before acting: `wiki status --project <name>` or `wiki session show`.
3. Follow the current phase exactly; do not skip TDD, review, close, or handover gates.
4. Keep generated skill source in this repo only; do not install or symlink into `~/.pi`.
5. When details matter, read the referenced one-hop doc now, then return to this workflow.

## Agent steps

1. Run `wiki status --project <project> --with-doc` to read the active phase and inline guidance.
2. If no session exists, run the requested init, plan, migration, or ad-hoc command explicitly.
3. Pick the phase route below and use only the matching CLI verbs.
4. Run tests or checks named by the active slice/PRD.
5. Record the state transition through the CLI.
6. Finish by updating the slice/PRD and writing or closing a handover when context should persist.

## Phase routing

- **plan**: Read `PHASE-PLAN.md` NOW. Use `wiki plan ...` to collect questions, constraints, and proposed scope.
- **prd**: Read `PHASE-PRD.md` NOW. Use `wiki prd create|set|publish|close`; keep acceptance testable.
- **slice**: Read `PHASE-SLICE.md` NOW. Use `wiki slice create|append|set`; keep one vertical outcome per slice.
- **triage**: Read `PHASE-TRIAGE.md` NOW. Use `wiki status`, `wiki search`, and artifact `set` verbs to restore truth.
- **red/green/TDD**: Load `/tdd`. Use `wiki slice red` for a failing behavior, then `wiki slice green` for the passing behavior.
- **close**: Verify todos, evidence, and review verdict, then run `wiki slice close` or `wiki prd close`.
- **handover**: Read `PHASE-HANDOVER.md` NOW. Use `wiki handover write|create|close`.

## Admin routing

- **vault init/doctor/sync/bless**: Read `ADMIN-VAULT.md` NOW before running admin commands.
- **migrate**: Read `ADMIN-MIGRATION.md` NOW before moving v1 content into v2.
