---
template: prd
version: 1
schema:
  id:           { type: string,    required: true,  pattern: "PRD-\\d{3,}", description: "Canonical PRD identifier" }
  aliases:         { type: list,      default: [] }
  title:        { type: string,    required: true,  min: 5, max: 100 }
  summary:      { type: string,    required: true,  min: 10, max: 200, description: "One-line scannable summary, rendered atop the body" }
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
<!--
<%*
// Only runs when created via Templater in Obsidian
const title = await tp.system.prompt("Title");
const project = await tp.system.prompt("Project name");
-%>
-->
# {{title}}

> {{id}} · {{project}} · `INPUT[select(option(draft), option(ready), option(in-progress), option(closed), option(superseded)):status]`

**Triage:** `INPUT[select(option(needs-triage), option(ready-for-agent), option(blocked), option(deferred)):triage_label]`

{{summary}}

## Problem Statement

{{problem_statement}}

> The problem the user is facing, from the user's perspective. Avoid jumping to solution language.

## Solution

{{solution}}

> The solution to the problem, from the user's perspective. Outcome-focused, not implementation-focused.

## User Stories

{{user_stories}}

> A long, numbered list. Format: `1. As a <actor>, I want a <feature>, so that <benefit>.`
> Cover all aspects of the feature. Extensive is better than terse.

## Implementation Decisions

{{implementation_decisions}}

> The modules to build/modify, their interfaces, architectural decisions, schema changes, API contracts, specific interactions.
> No file paths. No code snippets except: a prototype snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape). Trim to the decision-rich parts.

## Testing Decisions

{{testing_decisions}}

> What makes a good test for this work (test behavior through public interfaces, not implementation details).
> Which modules will be tested. Prior art for the tests (similar test patterns in the codebase).

## Out of Scope

{{out_of_scope}}

> What is deliberately excluded from this PRD.

## Further Notes

{{further_notes}}

## Slices

{{#each slices}}- [[{{this}}]]
{{else}}_None yet. Run `wiki slice create --prd {{id}}` to add._{{/each}}
