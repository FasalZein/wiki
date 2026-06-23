---
template: handoff
version: 1
schema:
  id:             { type: string,    required: true,  pattern: "HANDOFF-\\d{4,}" }
  aliases:         { type: list,      default: [] }
  project:        { type: string,    required: true }
  summary:        { type: string,    required: true,  min: 10, max: 200, description: "One-line scannable summary, rendered atop the body" }
  session_date:   { type: date,      required: true, auto: true }
  phase:          { type: enum,      required: true,  values: [plan, prd, slice, handoff, ad-hoc] }
  decisions_made: { type: link_list, target: decision, default: [] }
  status:         { type: enum,      required: true, values: [open, completed, archived], default: open }
  created:        { type: date,      auto: true }
---
# Handoff {{id}} — {{title}}

> {{project}} · {{session_date}} · phase: {{phase}} · `INPUT[select(option(open), option(completed), option(archived)):status]`

{{summary}}

## What this session produced

{{produced}}

> Concrete, scannable list. Each item references an artifact by ID or path. Do not duplicate content already in those artifacts.

## Decisions locked

{{#each decisions_made}}- [[{{this}}]]
{{else}}_None this session._
{{/each}}

## Open questions / next steps

{{open}}

> What the next agent should pick up. Be specific — name the next artifact to write or the next decision to surface. Reference artifacts by ID rather than restating their content.

## Pointers

{{pointers}}

> Paths to relevant files, research briefs, prior handoffs. References, not copies.

## Sensitive data

> Redact API keys, passwords, PII. If anything was redacted, note it here without the actual value.
