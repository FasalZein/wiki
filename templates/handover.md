---
template: handover
version: 1
schema:
  id:             { type: string,    required: true,  pattern: "HANDOVER-\\d{4,}" }
  aliases:         { type: list,      default: [] }
  project:        { type: string,    required: true }
  session_date:   { type: date,      required: true, auto: true }
  phase:          { type: enum,      required: true,  values: [plan, prd, slice, red, green, review, close, handover, ad-hoc] }
  next_phase:     { type: enum,      values: [plan, prd, slice, red, green, review, close, handover, ad-hoc] }
  active_prd:     { type: link,      target: prd, description: "PRD this session was operating on, if any" }
  active_slices:  { type: link_list, target: slice, default: [], description: "Slices in progress at handover time" }
  decisions_made: { type: link_list, target: decision, default: [] }
  suggested_skills: { type: list,    default: [], description: "Skills the next agent should load on resume" }
  status:         { type: enum,      required: true, values: [open, completed, archived], default: open }
  created:        { type: date,      auto: true }
---
<!--
<%*
// Only runs when created via Templater in Obsidian
const project = await tp.system.prompt("Project name");
const session_date = tp.date.now("YYYY-MM-DD");
-%>
-->
# Handover {{id}} — {{title}}

> {{project}} · {{session_date}} · phase: {{phase}} → next: {{next_phase}} · `INPUT[select(option(open), option(completed), option(archived)):status]`

## What this session produced

{{produced}}

> Concrete, scannable list. Each item references an artifact by ID or path. Do not duplicate content already in those artifacts.

## Decisions locked

{{#each decisions_made}}- [[{{this}}]]
{{else}}_None this session._
{{/each}}

## Active context

- **PRD:** {{#if active_prd}}[[{{active_prd}}]]{{else}}_none_{{/if}}
- **Slices in flight:** {{#each active_slices}}[[{{this}}]] {{else}}_none_{{/each}}

## Open questions / next steps

{{open}}

> What the next agent should pick up. Be specific — name the next gate, the next artifact to write, or the next decision to surface. Reference artifacts by ID rather than restating their content.

## Suggested skills

{{#each suggested_skills}}- `{{this}}`
{{else}}- `/wiki` (default)
{{/each}}

## Pointers

{{pointers}}

> Paths to relevant files, research briefs, prior handovers. References, not copies.

## Sensitive data

> Redact API keys, passwords, PII. If anything was redacted, note it here without the actual value.
