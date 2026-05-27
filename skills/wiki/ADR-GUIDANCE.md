# ADR Guidance

Wiki ADRs are vault artifacts created via `wiki create decision`. The template
defines the schema; this doc covers *when* to create one and *what qualifies*.

## When to offer an ADR

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will look at the code and
   wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you
   picked one for specific reasons.

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not
surprising, nobody will wonder why. If there was no real alternative, there's
nothing to record beyond "we did the obvious thing."

## What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is
  event-sourced, the read model is projected."
- **Integration patterns between contexts.** "Ordering and Billing communicate
  via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth
  provider, deployment target. Not every library — just the ones that would
  take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer
  context; other contexts reference it by ID only." The explicit no's are as
  valuable as the yes's.
- **Deliberate deviations from the obvious path.** "We use manual SQL instead
  of an ORM because X." Anything where a reasonable reader would assume the
  opposite.
- **Constraints not visible in the code.** "We can't use AWS because of
  compliance." "Response times must be under 200ms because of the partner API."
- **Rejected alternatives when the rejection is non-obvious.** If you considered
  GraphQL and picked REST for subtle reasons, record it — otherwise someone
  will suggest GraphQL again in six months.

## What does NOT qualify

- Obvious choices or framework defaults.
- Decisions that are easy to reverse (just change it later).
- Implementation details that are already clear from the code.

## Format

The `wiki create decision` template handles the structure. Fill at minimum:
- **context** — why this decision came up.
- **decision** — what was chosen and why.
- **status** — `proposed`, `accepted`, `deprecated`, or `superseded by ADR-NNNN`.

Optional: `alternatives` (only when rejected options are worth remembering),
`consequences` (only when non-obvious downstream effects need calling out).
