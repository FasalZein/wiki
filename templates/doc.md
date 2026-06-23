---
template: doc
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "DOC-\\d{4,}", description: "Canonical doc identifier" }
  aliases:         { type: list,      default: [] }
  title:        { type: string,    required: true,  min: 5, max: 120 }
  summary:      { type: string,    required: true,  min: 10, max: 200, description: "One-line scannable summary, rendered atop the body" }
  project:      { type: string,    required: true,  description: "Project name; must match project folder" }
  type:         { type: enum,      required: true,  values: [runbook, research, guide, learning, reference], description: "Knowledge artifact type" }
  tags:         { type: list,      default: [], description: "Cross-cutting topic tags for filtering" }
  related:      { type: link_list, default: [], description: "Links to related docs, PRDs, or decisions" }
  source_url:   { type: string,    description: "Source URL for research docs sourced from web" }
  force_new_reason: { type: string, min: 30, description: "Justification required if dedup gate (ADR-0010) was overridden" }
  created:      { type: date,      auto: true }
  updated:      { type: date,      auto: true }
---
# {{title}}

> {{id}} · {{project}} · {{type}}

{{summary}}

## Content

{{content}}

> The main body of this knowledge artifact.

## Tags

{{#each tags}}`{{this}}` {{else}}_none_{{/each}}

## Related

{{#each related}}- [[{{this}}]]
{{else}}_none_{{/each}}
