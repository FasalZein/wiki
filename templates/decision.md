---
template: decision
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "ADR-\\d{3,}|DECISION-\\d{4,}", description: "ADR-NNNN (DECISION-NNNN legacy alias still accepted)" }
  aliases:         { type: list,      default: [] }
  title:        { type: string,    required: true,  min: 5 }
  summary:      { type: string,    required: true,  min: 10, description: "One-line scannable summary, rendered atop the body" }
  group:        { type: string,    description: "Optional section heading for this artifact in the generated index.md" }
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

{{summary}}

## Context

{{context}}

## Decision

{{decision}}

## Consequences

{{consequences}}
