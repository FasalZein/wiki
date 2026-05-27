---
based-on: mattpocock/skills/engineering/grill-with-docs@b8be62f
fork-rationale: Keeps the questioning discipline but treats plans as vault notes edited directly in Obsidian.
---
# Phase: plan

Goal: turn a vague request into bounded work the vault can track.

## When to enter plan phase

Use plan when the problem is fuzzy, multiple approaches exist, or scope is
unbounded. Skip plan and go straight to PRD when the work is already well
understood and scoped.

## Create a plan

Plans are vault notes — create them directly in Obsidian:

```
obsidian create --folder projects/<name>/plans --template plan "Short description of the problem"
```

Fill the plan with sections: `problem_drafts`, `solution_drafts`,
`acceptance_drafts`, `user_stories_drafts`, `notes`. Edit fields directly:

```
obsidian property:set <plan-file> notes "Explored caching but ruled it out"
```

## Grill discipline

Ask one question at a time. Do not batch questions — each answer may
invalidate the next question.

- Challenge vague terms against domain-language.md. If a term is not defined
  there, resolve it before continuing.
- Prefer concrete options ("A or B?") over open-ended prompts ("what do you
  think?").
- Stop questioning when every open_question is resolved and constraints are
  recorded.

## When to create ADRs

Record a decision (ADR) only when:
- The choice is hard to reverse after implementation begins.
- The trade-off would surprise a future reader who wasn't in the room.
- Two reasonable engineers would pick different options.

Do not create ADRs for obvious choices or framework defaults. Use `wiki create decision`
to create ADR artifacts.

## Promote to PRD

When the plan is complete, create a PRD from it:

```
wiki create prd --project <name> --title "Title from the plan"
```

Then fill the PRD sections using the plan content as input. See `PHASE-PRD.md`.

## Exit criteria

- Scope is bounded: there is a clear "what is in" and "what is out."
- Success criteria are testable: each criterion can be verified by a human or
  automated check.
- No unresolved open questions remain in the plan.
- If ADRs were needed, they are recorded and accepted.
