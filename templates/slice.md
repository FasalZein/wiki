---
template: slice
version: 1
schema:
  id:              { type: string,    required: true,  pattern: "SLICE-\\d{3,}" }
  aliases:         { type: list,      default: [] }
  title:           { type: string,    required: true,  min: 5, max: 80 }
  summary:         { type: string,    required: true,  min: 10, max: 200, description: "One-line scannable summary, rendered atop the body" }
  group:           { type: string,    description: "Optional section heading for this artifact in the generated index.md" }
  project:         { type: string,    required: true }
  parent_prd:      { type: link,      target: prd }
  status:          { type: enum,      required: true, values: [planned, red, green, closed, blocked, superseded], default: planned }
  type:            { type: enum,      required: true, values: [HITL, AFK], default: AFK, description: "HITL = needs human interaction; AFK = agent-completable" }
  blocked_by:      { type: link_list, target: slice, default: [] }
  user_stories:    { type: list,      default: [], description: "References to PRD user-story IDs covered by this slice" }
  acceptance:      { type: list,      required: true, default: [], description: "Checkboxes; one per criterion." }
  red_log_ref:     { type: file_ref,  description: "CLI-state path to captured failing-test output (set via `wiki set`)" }
  green_log_ref:   { type: file_ref,  description: "CLI-state path to captured passing-test output (set via `wiki set`)" }
  review_verdict:  { type: enum,      values: [pass, pass-with-notes, reject], description: "Review outcome (set via `wiki set`)" }
  tdd_exempt:      { type: boolean,   default: false }
  tdd_exempt_reason: { type: string,  min: 20, description: "Required when tdd_exempt=true; explains why this slice ships without new tests" }
  supersedes:      { type: link,      target: slice }
  superseded_by:   { type: link,      target: slice }
  related:         { type: link_list, target: slice, default: [] }
  force_new_reason:{ type: string,    min: 30, description: "Required if dedup gate (ADR-0010) was overridden" }
  created:         { type: date,      auto: true }
  updated:         { type: date,      auto: true }
---
# {{title}}

> {{id}} · {{project}} · {{status}} · {{type}}

{{summary}}

## Parent

[[{{parent_prd}}]]

## What to build

{{what_to_build}}

## Acceptance criteria

{{#each acceptance}}- [ ] {{this}}
{{/each}}

## Todo

- [ ] Write tests
- [ ] Implement feature
- [ ] Verify acceptance criteria

## Blocked by

{{#each blocked_by}}- [[{{this}}]]
{{else}}None — can start immediately.
{{/each}}

## Evidence

- **Red log:** {{red_log_ref}}
- **Green log:** {{green_log_ref}}
- **Review verdict:** {{review_verdict}}
