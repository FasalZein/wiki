# Out-of-Scope Decisions

When a feature request or enhancement is deliberately rejected during triage or
a grill session, record it as an ADR with status `rejected` so the reasoning
isn't lost. This is the wiki equivalent of Matt Pocock's `.out-of-scope/`
directory pattern — wiki uses ADR artifacts instead of standalone files.

## Why record rejections

1. **Institutional memory** — why a feature was rejected, so the reasoning isn't
   lost when the conversation ends.
2. **Deduplication** — when a similar request comes up later, the agent can
   surface the previous decision instead of re-litigating it.

## How to record

Create a decision artifact with status `rejected`:

```
wiki create decision --project <name> --title "Dark mode support"
obsidian property:set <decision-file> status rejected
obsidian property:set <decision-file> context "Requested in SLICE-042 and during grill session 2026-05-28"
obsidian property:set <decision-file> decision "Out of scope — rendering pipeline assumes single color palette resolved at build time. Theming is a downstream consumer concern."
```

The decision field should be substantive — not "we don't want this" but why.
Good reasons reference:

- Project scope or philosophy ("This project focuses on X; theming is a
  downstream concern").
- Technical constraints ("Supporting this would require Y, which conflicts with
  our Z architecture").
- Strategic decisions ("We chose to use A instead of B because...").

Avoid referencing temporary circumstances ("we're too busy right now") — those
aren't real rejections, they're deferrals.

## When to check during triage

During triage (Step 1: Gather context), search for prior rejected decisions:

```
wiki search "dark mode" --project <name> --type decision
```

When evaluating a new request:
- Check if it matches an existing rejected decision.
- Matching is by concept similarity, not keyword — "night theme" matches a
  "dark mode" rejection.
- If there's a match, surface it: "We rejected this before (ADR-0012) because
  [reason]. Do you still feel the same way?"

The user may:
- **Confirm** — note the new request in the existing ADR's context field, move on.
- **Reconsider** — update the ADR status to `superseded` or `deprecated`, proceed
  with a fresh grill.
- **Disagree** — the requests are related but distinct, proceed with normal triage.

## When NOT to record

- Bug reports — only enhancement rejections get recorded as out-of-scope.
- Deferrals — "not now" is not "never." If the work will happen later, track it
  as a planned slice or a note in the PRD, not a rejection.
