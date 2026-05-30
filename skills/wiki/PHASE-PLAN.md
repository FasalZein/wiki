---
based-on: mattpocock/skills/engineering/grill-with-docs@b8be62f
fork-rationale: Wiki-medium grill — questioning discipline writes ADRs and reusable context docs to the vault.
---
# Phase: plan (grill)

Goal: turn a vague request into bounded, well-understood work by grilling the
user with focused questions, recording decisions as ADRs, and refining the
project's documented vocabulary and decisions.

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

### Challenge against existing docs

When the user uses a term that conflicts with existing PRDs, ADRs, slices, or docs,
call it out immediately. "This doc defines 'cancellation' as X, but you seem to mean
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

## Capture reusable context in docs

When a domain term, project convention, or reusable explanation is resolved, create or
update a doc in `docs/` rather than maintaining a separate architecture glossary.
Keep the doc focused and searchable; ADRs still record decisions.

### Entry format

```md
**Term**:
One or two sentence definition of what it IS (not what it does).
_Avoid_: Synonyms to reject
```

### Rules

- **Be opinionated.** Pick the best term and list others under _Avoid_.
- **Flag conflicts explicitly.** If a term is used ambiguously, call it out with
  a clear resolution.
- **Keep definitions tight.** One or two sentences max.
- **Show relationships.** Express cardinality where obvious ("an Order has many
  LineItems").
- **Only include terms specific to this project.** General programming concepts
  don't belong.
- **Group terms under subheadings** when natural clusters emerge.
- **Write an example dialogue.** A conversation between a dev and a domain expert
  that demonstrates how the terms interact naturally.

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

An ADR can be a single paragraph. The value is in recording *that* a decision
was made and *why* — not in filling out sections. Optional fields: **alternatives**
(only when rejected options are worth remembering), **consequences** (only when
non-obvious downstream effects need calling out).

### When to offer an ADR

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will wonder "why?"
3. **Real trade-off** — genuine alternatives existed and you picked one for
   specific reasons.

If a decision is easy to reverse, skip it. If it's not surprising, nobody will
wonder why. If there was no real alternative, there's nothing to record.

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is
  event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate
  via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider,
  deployment target. Not every library — just the ones that take a quarter to swap.
- **Boundary and scope decisions.** "Customer data is owned by the Customer
  context; other contexts reference it by ID only." The explicit no's are as
  valuable as the yes's.
- **Deliberate deviations from the obvious path.** "We use manual SQL instead of
  an ORM because X." These stop the next engineer from "fixing" something
  deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of
  compliance." "Response times must be under 200ms because of the partner API."
- **Rejected alternatives when non-obvious.** Record it so someone doesn't
  suggest the same thing again in six months.

## Example: docs entry produced during a grill

```md
**Artifact**:
A versioned vault record with typed frontmatter — PRDs, slices, decisions, or handovers.
_Avoid_: document, note, file, ticket
```

## Promote to PRD

When all questions are resolved and ADRs are recorded, create a PRD:

```
wiki create prd --project <name> --title "Title from the grill"
```

The PRD should reference the ADRs created during this phase in its
`implementation_decisions` field. See `PHASE-PRD.md`.

## Exit criteria

- Scope is bounded: there is a clear "what is in" and "what is out."
- Success criteria are testable.
- No unresolved open questions remain.
- ADRs are recorded for all non-trivial decisions.
- Reusable terms or context are captured in docs when they matter beyond this artifact.
