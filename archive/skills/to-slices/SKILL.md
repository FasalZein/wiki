---
name: to-slices
description: "Slice a PRD or plan into independently-grabbable vertical slices — tracer bullets, each with acceptance criteria — for an implementing agent to pick up. Use when the user wants to turn a PRD or plan into implementation tickets, or plan delivery work."
---

# /to-slices

The downstream half of `to-prd` and the last planning step before implementation: a PRD
becomes a set of **vertical slices**, each an independently-grabbable unit of work that an
implementing agent picks up and builds.

## Step 1 — locate the source PRD

Work from the PRD this conversation produced, or the one the user points to in the slice
store. Read its full body — the user stories and implementation decisions are what you
slice. Use the project's domain glossary vocabulary and respect any ADRs in the area you
touch.

Done when you hold the PRD's user stories and decisions in hand.

## Step 2 — draft vertical slices

Cut the PRD into **tracer-bullet** slices: each a thin vertical cut through every
layer it touches end-to-end, demoable or verifiable on its own — never a horizontal
slice of one layer.

When a feature is too big to slice by eye, cut along a **SPIDR** seam: **S**pike (output is
knowledge, when you can't yet size it), **P**aths (happy path first, then each alternate/error
path), **I**nterfaces (one client/platform/API-only before full UI), **D**ata (one type/format/
region first), **R**ules (relax business rules, then add each back as its own slice). Workflow
steps and individual acceptance criteria are also clean seams.

- The first slice walks the whole skeleton.
- Write 3–8 **acceptance criteria** per slice: observable, testable statements that define
  "done". If you can't state one, the slice is too vague — split it or sharpen it.
- Mark each slice **AFK** (completable without a human-in-the-loop decision) or **HITL**
  (needs a human decision — an architecture or design review). Prefer AFK.
- Map each slice to the PRD **user stories** it covers.
- Note `blocked by`: any slice that can't start until another completes.

Each slice must pass **INVEST**.

Done when every PRD user story is covered by at least one slice, and every slice has
acceptance criteria, a type, and its blockers identified.

## Step 3 — quiz the user (required, never skip)

Present the breakdown as a numbered list, each slice in the Step 4 shape.

Ask:
- Is the granularity right — any slices to merge or split?
- Are the dependency relationships correct?
- Are the HITL/AFK marks correct?
- Do the acceptance criteria capture "done" for each slice?

Iterate until the user **explicitly approves** — never publish unilaterally.

## Step 4 — publish

Write each approved slice to the slice store using the shape below, in dependency order
(blockers first) so a slice can reference the real ids of what blocks it.

<slice-shape>
## Parent
The source PRD's id/reference.

## What to build
A concise description of this vertical slice — the end-to-end behavior, not layer-by-layer
implementation. No file paths, no code snippets — they go stale. Exception: a prototype
snippet that encodes a decision more precisely than prose can (state machine, reducer,
schema, type shape); inline only the decision-rich parts and note it came from a prototype.

## Type
AFK or HITL (see Step 2).

## User stories covered
The PRD user-story references this slice addresses.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by
References to blocking slices, or "None — can start immediately."
</slice-shape>

Do not close or modify the parent PRD.

Done when every approved slice exists in the slice store, in dependency order, with the
parent PRD untouched.
