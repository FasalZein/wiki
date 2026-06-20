---
template: slice
version: 1
schema:
  id:              { type: string,    required: true,  pattern: "SLICE-\\d{3,}" }
  aliases:         { type: list,      default: [] }
  title:           { type: string,    required: true,  min: 5, max: 80 }
  project:         { type: string,    required: true }
  parent_prd:      { type: link,      target: prd }
  status:          { type: enum,      required: true, values: [planned, red, green, closed, blocked, superseded], default: planned }
  type:            { type: enum,      required: true, values: [HITL, AFK], default: AFK, description: "HITL = needs human interaction; AFK = agent-completable" }
  blocked_by:      { type: link_list, target: slice, default: [] }
  user_stories:    { type: list,      default: [], description: "References to PRD user-story IDs covered by this slice" }
  acceptance:      { type: list,      required: true, default: [], description: "Checkboxes; one per criterion. SLICE-006 state machine enforces non-empty before transitioning out of planned." }
  red_log_ref:     { type: file_ref,  description: "CLI-state path to captured failing-test output; set by `wiki slice red`" }
  green_log_ref:   { type: file_ref,  description: "CLI-state path to captured passing-test output; set by `wiki slice green`" }
  review_verdict:  { type: enum,      values: [pass, pass-with-notes, reject], description: "Set by `wiki slice close` via review-phase skill" }
  tdd_exempt:      { type: boolean,   default: false }
  tdd_exempt_reason: { type: string,  min: 20, description: "Required when tdd_exempt=true; explains why this slice ships without new tests" }
  supersedes:      { type: link,      target: slice }
  superseded_by:   { type: link,      target: slice }
  related:         { type: link_list, target: slice, default: [] }
  force_new_reason:{ type: string,    min: 30, description: "Required if dedup gate (ADR-0010) was overridden" }
  created:         { type: date,      auto: true }
  updated:         { type: date,      auto: true }
---
<!--
<%*
// Only runs when created via Templater in Obsidian
const title = await tp.system.prompt("Title");
const project = await tp.system.prompt("Project name");
const parent_prd = await tp.system.prompt("Parent PRD (e.g. PRD-001)");
const type = await tp.system.suggester(["AFK", "HITL"], ["AFK", "HITL"]);
-%>
-->
# {{title}}

> {{id}} · {{project}} · `INPUT[select(option(planned), option(red), option(green), option(closed), option(blocked), option(superseded)):status]` · `INPUT[select(option(AFK), option(HITL)):type]`

## Parent

[[{{parent_prd}}]]

## What to build

{{what_to_build}}

> A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.
> No file paths. No code snippets except: a prototype snippet that encodes a decision more precisely than prose can. Trim to the decision-rich parts.

## Acceptance criteria

{{#each acceptance}}- [ ] {{this}}
{{/each}}

## Todo

- [ ] Write tests
- [ ] Implement feature
- [ ] Verify acceptance criteria

> Slice close (`wiki slice close`) is gated on every item above being done.

## Blocked by

{{#each blocked_by}}- [[{{this}}]]
{{else}}None — can start immediately.
{{/each}}

## Evidence

- **Red log:** {{red_log_ref}}
- **Green log:** {{green_log_ref}}
- **Review verdict:** {{review_verdict}}

> Set automatically by the slice state machine. See ADR-0005.
