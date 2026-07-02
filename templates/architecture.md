---
template: architecture
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "ARCH-\\d{4,}", description: "Canonical architecture identifier" }
  aliases:         { type: list,      default: [] }
  title:        { type: string,    required: true,  min: 5 }
  summary:      { type: string,    required: true,  min: 10, description: "One-line scannable summary, rendered atop the body" }
  group:        { type: string,    description: "Optional section heading for this artifact in the generated index.md" }
  project:      { type: string,    required: true,  description: "Project name; must match project folder" }
  tags:         { type: list,      default: [], description: "Cross-cutting topic tags for filtering" }
  related:      { type: link_list, default: [], description: "Links to related docs, PRDs, or decisions" }
  source_url:   { type: string,    description: "Source URL for research docs sourced from web" }
  force_new_reason: { type: string, min: 30, description: "Justification required if dedup gate (ADR-0010) was overridden" }
  created:      { type: date,      auto: true }
  updated:      { type: date,      auto: true }
---
# {{title}}

> {{id}} · {{project}}

{{summary}}

## Content

{{content}}

## Tags

{{#each tags}}`{{this}}` {{else}}_none_{{/each}}

## Related

{{#each related}}- [[{{this}}]]
{{else}}_none_{{/each}}
