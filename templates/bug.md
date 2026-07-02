---
template: bug
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "BUG-\\d{4,}", description: "Canonical bug identifier" }
  aliases:         { type: list,      default: [] }
  title:        { type: string,    required: true,  min: 5 }
  summary:      { type: string,    required: true,  min: 10, description: "One-line scannable summary, rendered atop the body" }
  group:        { type: string,    description: "Optional section heading for this artifact in the generated index.md" }
  project:      { type: string,    required: true,  description: "Project name; must match project folder" }
  severity:     { type: enum,      values: [low, medium, high, critical], description: "Impact of the bug" }
  status:       { type: enum,      required: true, values: [open, diagnosed, fixed, wontfix], default: open }
  tags:         { type: list,      default: [], description: "Cross-cutting topic tags for filtering" }
  related:      { type: link_list, default: [], description: "Links to related bugs, docs, PRDs, or decisions" }
  force_new_reason: { type: string, min: 30, description: "Justification required if dedup gate (ADR-0010) was overridden" }
  created:      { type: date,      auto: true }
  updated:      { type: date,      auto: true }
---
# {{title}}

> {{id}} · {{project}} · {{status}}

{{summary}}

## Content

{{content}}

## Tags

{{#each tags}}`{{this}}` {{else}}_none_{{/each}}

## Related

{{#each related}}- [[{{this}}]]
{{else}}_none_{{/each}}
