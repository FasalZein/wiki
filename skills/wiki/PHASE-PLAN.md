---
based-on: mattpocock/skills/engineering/grill-with-docs@b8be62f
fork-rationale: Wiki-medium grill — questioning discipline writes ADRs to vault and refines domain-language.md instead of free-form docs.
---
# Phase: plan (grill)

Goal: turn a vague request into bounded, well-understood work by grilling the
user with focused questions, recording decisions as ADRs, and refining the
project's domain language.

## When to enter plan phase

Use plan when the problem is fuzzy, multiple approaches exist, or scope is
unbounded. Skip plan and go straight to PRD when the work is already well
understood and scoped. Triage chains here when context is lost and scope
needs re-establishing.

## Grill discipline

Ask one question at a time. Do not batch questions — each answer may
invalidate the next question.

- Challenge vague terms against `domain-language.md`. If a term is not defined
  there, define it before continuing.
- Prefer concrete options ("A or B?") over open-ended prompts ("what do you
  think?").
- When the user introduces a new concept, update `domain-language.md` via
  `obsidian read` + direct edit before referencing it in any artifact.
- Stop questioning when every open question is resolved and constraints are
  recorded.

## Record decisions as ADRs

When a grill question surfaces a non-trivial trade-off, record it:

```
wiki create decision --project <name> --title "Short decision title"
```

Then fill the ADR fields:

```
obsidian property:set <decision-file> context "Why this decision came up"
obsidian property:set <decision-file> decision "What we chose and why"
obsidian property:set <decision-file> status accepted
```

Create an ADR only when:
- The choice is hard to reverse after implementation begins.
- The trade-off would surprise a future reader who wasn't in the room.
- Two reasonable engineers would pick different options.

Do not create ADRs for obvious choices or framework defaults.

## Promote to PRD

When all questions are resolved and ADRs are recorded, create a PRD:

```
wiki create prd --project <name> --title "Title from the grill"
```

The PRD should reference the ADRs created during this phase in its
`implementation_decisions` field. See `PHASE-PRD.md`.

## Exit criteria

- Scope is bounded: there is a clear "what is in" and "what is out."
- Success criteria are testable: each criterion can be verified by a human or
  automated check.
- No unresolved open questions remain.
- ADRs are recorded for all non-trivial decisions.
- `domain-language.md` is updated with any new terms introduced.
