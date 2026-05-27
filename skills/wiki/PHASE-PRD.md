---
based-on: mattpocock/skills/engineering/to-prd@b8be62f
fork-rationale: Preserves product-requirement structure while routing creates through wiki CLI and field edits through Obsidian.
---
# Phase: PRD

Goal: create or refine a product requirement that can drive slices.

## Inputs

A PRD implements decisions from a preceding grill (plan phase). Reference
ADRs by ID in the `implementation_decisions` field. If no grill was needed
(scope was already clear), note that in `implementation_decisions`.

## Process

Do NOT interview the user — synthesize what you already know from the
conversation and codebase exploration.

1. **Explore the codebase** to understand the current state. Use the project's
   domain glossary vocabulary throughout the PRD, and respect any ADRs in the
   area you're touching.

2. **Sketch major modules** you will need to build or modify. Actively look for
   opportunities to extract deep modules — small interface, deep implementation,
   testable in isolation. Check with the user that these modules match their
   expectations. Check which modules they want tests written for.

3. **Create and fill the PRD** using the steps below.

## Create a PRD

```
wiki create prd --project <name> --title "Short descriptive title"
```

Returns a PRD ID (e.g. PRD-003). Status starts at `draft`.

## Required sections

Fill every section before publishing. Use `obsidian property:set` for each:

- **problem_statement** — the user problem, from the user's perspective.
- **solution** — outcome-focused, not implementation-focused.
- **user_stories** — long, numbered list: `As a <actor>, I want <feature>, so
  that <benefit>.` This list should be extensive and cover all aspects.
- **implementation_decisions** — modules, interfaces, schema changes,
  architectural decisions, API contracts. No file paths — they go stale.
  Exception: if a prototype produced a snippet that encodes a decision more
  precisely than prose can (state machine, reducer, schema, type shape), inline
  it and note it came from a prototype.
- **testing_decisions** — what makes a good test (only test external behavior,
  not implementation details), which modules, prior art in the codebase.
- **out_of_scope** — what is deliberately excluded.

## Domain terms

Every domain-specific term used in the PRD must exist in domain-language.md.
If a term is missing, define it there before using it in the PRD.

## Publish

Set the status to `ready` once all required sections are filled:

```
obsidian property:set <prd-file> status ready
```

Verify all required sections are present before publishing. A PRD with empty
required sections should not be marked ready.

## Acceptance criteria

Every user story must map to at least one slice. A PRD with unmapped stories
cannot be closed.

## Close

Set the status to `closed` once all linked slices are in `closed` status:

```
obsidian property:set <prd-file> status closed
```

Verify all linked slices are closed before setting this status.
