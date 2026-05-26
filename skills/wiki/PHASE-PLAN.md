---
based-on: mattpocock/skills/engineering/grill-with-docs@b8be62f
fork-rationale: Keeps the questioning discipline but records outcomes through wiki CLI planning artifacts instead of free-form docs.
---
# Phase: plan

Goal: turn a vague request into bounded work the vault can track.

## When to enter plan phase

Use plan when the problem is fuzzy, multiple approaches exist, or scope is
unbounded. Skip plan and go straight to PRD when the work is already well
understood and scoped.

## Create a plan

```
wiki plan create --project <name> --title "Short description of the problem"
```

Returns a plan ID (e.g. PLAN-0001). Status starts at `draft`. Fields:
`problem_drafts`, `solution_drafts`, `acceptance_drafts`, `user_stories_drafts`,
`notes`. Fill list fields with `wiki plan append`, scalar fields with
`wiki plan set`:

```
wiki plan append <id> --project <name> --field problem_drafts "Users lose context between sessions"
wiki plan set <id> --project <name> --field notes "Explored caching but ruled it out"
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

Do not create ADRs for obvious choices or framework defaults.

## Review and promote

```
wiki plan show <id>            # review the plan artifact
wiki plan promote <id>         # graduate to PRD phase
```

`promote` refuses if open_questions is non-empty or success_criteria is blank.

## Exit criteria

- Scope is bounded: there is a clear "what is in" and "what is out."
- Success criteria are testable: each criterion can be verified by a human or
  automated check.
- No unresolved open questions remain in the plan artifact.
- If ADRs were needed, they are recorded and accepted.
