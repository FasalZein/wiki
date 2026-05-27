---
based-on: mattpocock/skills/engineering/to-prd@b8be62f
fork-rationale: Preserves product-requirement structure while routing creates through wiki CLI and field edits through Obsidian.
---
# Phase: PRD

Goal: create or refine a product requirement that can drive slices.

## Create a PRD

```
wiki create prd --project <name> --title "Short descriptive title"
```

Returns a PRD ID (e.g. PRD-003). Status starts at `draft`.

## Required sections

Fill every section before publishing. Use `obsidian property:set` for each:

- **problem_statement** — the user problem, from the user's perspective.
- **solution** — outcome-focused, not implementation-focused.
- **user_stories** — numbered list: `As a <actor>, I want <feature>, so that <benefit>.`
- **implementation_decisions** — modules, interfaces, schema changes. No file paths.
- **testing_decisions** — what makes a good test, which modules, prior art.
- **out_of_scope** — what is deliberately excluded.

For long values, pipe content via stdin:

```
echo "Users cannot reset passwords without email verification" | \
  obsidian property:set <prd-file> problem_statement -
```

Short values work inline:

```
obsidian property:set <prd-file> title "New title"
```

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

## Reading PRDs

```
obsidian read <prd-file>                   # display full PRD with current field values
```
