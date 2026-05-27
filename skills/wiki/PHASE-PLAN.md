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

Interview the user relentlessly about every aspect of the plan. Walk down each
branch of the design tree, resolving dependencies one-by-one. For each question,
provide your recommended answer.

Ask one question at a time. Do not batch questions — each answer may
invalidate the next question. If a question can be answered by exploring the
codebase, explore the codebase instead of asking.

### Challenge against the glossary

When the user uses a term that conflicts with `domain-language.md`, call it out
immediately. "Your glossary defines 'cancellation' as X, but you seem to mean
Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term.
"You're saying 'account' — do you mean the Customer or the User? Those are
different things." Be opinionated — pick the best term and list others as
aliases to avoid.

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific
scenarios. Invent scenarios that probe edge cases and force the user to be
precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you
find a contradiction, surface it: "Your code does X, but you just said Y —
which is right?"

## Update domain-language.md

When a term is resolved, update `domain-language.md` right there — don't batch.
See [DOMAIN-LANGUAGE-FORMAT.md](DOMAIN-LANGUAGE-FORMAT.md) for the entry format.

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

Create an ADR only when all three are true:
- **Hard to reverse** — the cost of changing your mind later is meaningful.
- **Surprising without context** — a future reader will wonder "why?"
- **Real trade-off** — genuine alternatives existed and you picked one for
  specific reasons.

For what qualifies and what doesn't, see [ADR-GUIDANCE.md](ADR-GUIDANCE.md).

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
