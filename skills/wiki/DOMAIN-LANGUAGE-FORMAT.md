# domain-language.md Format

Wiki projects use `domain-language.md` in the project folder as the glossary.
This is the wiki equivalent of Matt Pocock's `CONTEXT.md`.

## Structure

```md
# {Project Name} — Domain Language

{One or two sentence description of what this project is.}

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
  or conversation, call it out and resolve it before continuing.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not
  what it does.
- **Show relationships.** Use bold term names and express cardinality where
  obvious ("an Order has many LineItems").
- **Only include terms specific to this project.** General programming concepts
  (timeouts, error types, utility patterns) don't belong.
- **Group terms under subheadings** when natural clusters emerge. If all terms
  belong to a single cohesive area, a flat list is fine.
- **Update inline during the grill.** Don't batch — capture terms as they are
  resolved. This keeps the glossary current and prevents drift.
