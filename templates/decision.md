---
template: decision
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "DECISION-\\d{4,}|ADR-\\d{4,}", description: "DECISION-NNNN or ADR-NNNN (legacy alias accepted)" }
  title:        { type: string,    required: true,  min: 5, max: 100 }
  project:      { type: string,    required: true }
  status:       { type: enum,      required: true,  values: [proposed, accepted, superseded, rejected], default: accepted }
  context_terms:{ type: list,      default: [], description: "Canonical terms from domain-language.md referenced by this decision" }
  related_prd:  { type: link,      target: prd, description: "Originating PRD, if any" }
  related:      { type: link_list, target: decision, default: [] }
  supersedes:   { type: link,      target: decision }
  superseded_by:{ type: link,      target: decision }
  force_new_reason: { type: string, min: 30 }
  created:      { type: date,      auto: true }
  updated:      { type: date,      auto: true }
---
# {{title}}

> {{id}} · {{status}} · {{date}}

## Context

{{context}}

> What forces are at play. What problem this decision answers. Cite domain terms, prior decisions, and constraints. Stay short — context, not history.

## Decision

{{decision}}

> The choice taken. State it plainly, in one paragraph or a short list. No hedging.

## Consequences

{{consequences}}

> What follows from this decision — both the good and the awkward. List rejected alternatives at the end if any were considered.
