---
template: handoff
version: 1
schema:
  id:             { type: string,    required: true,  pattern: "HANDOFF-\\d{4,}" }
  aliases:         { type: list,      default: [] }
  project:        { type: string,    required: true }
  title:          { type: string,    required: true,  min: 5, description: "Session headline, rendered in the handoff header and index roster" }
  summary:        { type: string,    required: true,  min: 10, description: "One-line scannable summary, rendered atop the body" }
  group:          { type: string,    description: "Optional section heading for this artifact in the generated index.md" }
  session_date:   { type: date,      required: true, auto: true }
  phase:          { type: enum,      required: true,  values: [plan, prd, slice, handoff, ad-hoc] }
  decisions_made: { type: link_list, target: decision, default: [] }
  status:         { type: enum,      required: true, values: [open, completed, archived], default: open }
  created:        { type: date,      auto: true }
---
# Handoff {{id}} — {{title}}

> {{project}} · {{session_date}} · phase: {{phase}} · {{status}}

{{summary}}

## What this session produced

{{produced}}

## Decisions locked

{{#each decisions_made}}- [[{{this}}]]
{{else}}_None this session._
{{/each}}

## Open questions / next steps

{{open}}

## Pointers

{{pointers}}

## Sensitive data

{{sensitive_data}}
