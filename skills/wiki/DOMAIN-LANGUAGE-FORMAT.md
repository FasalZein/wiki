# domain-language.md Format

Wiki projects use `domain-language.md` in the project folder as the glossary.
This is the wiki equivalent of Matt Pocock's `CONTEXT.md`.

## Structure

```md
# {Project Name} — Domain Language

{One or two sentence description of what this project is and why it exists.}

## Language

**Order**:
A request from a customer to purchase one or more items.
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the
  best one and list the others under _Avoid_.
- **Flag conflicts explicitly.** If a term is used ambiguously in the codebase
  or conversation, call it out in the glossary with a clear resolution.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not
  what it does.
- **Show relationships.** Use bold term names and express cardinality where
  obvious ("an Order has many LineItems").
- **Only include terms specific to this project.** General programming concepts
  (timeouts, error types, utility patterns) don't belong even if the project
  uses them extensively. Before adding a term, ask: is this a concept unique to
  this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms
  belong to a single cohesive area, a flat list is fine.
- **Write an example dialogue.** A conversation between a dev and a domain
  expert that demonstrates how the terms interact naturally and clarifies
  boundaries between related concepts.
- **Update inline during the grill.** Don't batch — capture terms as they are
  resolved. This keeps the glossary current and prevents drift.

`domain-language.md` should be totally devoid of implementation details. Do not
treat it as a spec, a scratch pad, or a repository for implementation decisions.
It is a glossary and nothing else.
