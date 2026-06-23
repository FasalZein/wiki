---
template: prd
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "PRD-\\d{3,}", description: "Canonical PRD identifier" }
  aliases:         { type: list,      default: [] }
  title:        { type: string,    required: true,  min: 5, max: 100 }
  summary:      { type: string,    required: true,  min: 10, max: 200, description: "One-line scannable summary, rendered atop the body" }
  group:        { type: string,    description: "Optional section heading for this artifact in the generated index.md" }
  project:      { type: string,    required: true,  description: "Project name; must match project folder" }
  status:       { type: enum,      required: true,  values: [draft, ready, in-progress, closed, superseded], default: draft }
  triage_label: { type: enum,      values: [needs-triage, ready-for-agent, blocked, deferred], default: needs-triage }
  domain_terms: { type: list,      default: [], description: "Canonical terms from domain-language.md used in this PRD" }
  slices:       { type: link_list, target: slice, default: [], description: "Auto-populated from slices that reference this PRD" }
  related:      { type: link_list, target: prd, default: [] }
  supersedes:   { type: link,      target: prd }
  superseded_by:{ type: link,      target: prd }
  force_new_reason: { type: string, min: 30, description: "Justification required if dedup gate (ADR-0010) was overridden" }
  created:      { type: date,      auto: true }
  updated:      { type: date,      auto: true }
---
# {{title}}

> {{id}} · {{project}} · {{status}}

**Triage:** {{triage_label}}

{{summary}}

## Problem Statement

{{problem_statement}}

## Solution

{{solution}}

## User Stories

{{user_stories}}

## Implementation Decisions

{{implementation_decisions}}

## Testing Decisions

{{testing_decisions}}

## Out of Scope

{{out_of_scope}}

## Further Notes

{{further_notes}}

## Slices

{{#each slices}}- [[{{this}}]]
{{else}}_None yet. Run `wiki slice create --prd {{id}}` to add._{{/each}}
