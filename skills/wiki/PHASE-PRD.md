---
based-on: mattpocock/skills/engineering/to-prd@b8be62f
fork-rationale: Preserves product-requirement structure while routing all writes through wiki PRD commands.
---
# Phase: PRD

Goal: create or refine a product requirement that can drive slices.

## Create a PRD

```
wiki prd create --project <name> --title "Short descriptive title"
```

Returns a PRD ID (e.g. PRD-003). Status starts at `draft`.

## Required sections

Fill every section before publishing. Use `wiki prd set` for each:

- **problem_statement** — the user problem, from the user's perspective.
- **solution** — outcome-focused, not implementation-focused.
- **user_stories** — numbered list: `As a <actor>, I want <feature>, so that <benefit>.`
- **implementation_decisions** — modules, interfaces, schema changes. No file paths.
- **testing_decisions** — what makes a good test, which modules, prior art.
- **out_of_scope** — what is deliberately excluded.

For long values, pipe content via stdin:

```
echo "Users cannot reset passwords without email verification" | \
  wiki prd set PRD-003 --project wiki-v2 --field problem_statement -
```

Short values work inline:

```
wiki prd set PRD-003 --project wiki-v2 --field title "New title"
```

## Domain terms

Every domain-specific term used in the PRD must exist in domain-language.md.
If a term is missing, define it there before using it in the PRD.

## Publish

```
wiki prd publish <id>
```

Transitions `draft` to `ready`. Refuses if any required section is empty.
Auto-inlines PHASE-SLICE.md into the agent context so slicing can begin
immediately.

## Acceptance criteria

Every user story must map to at least one slice. A PRD with unmapped stories
cannot be closed.

## Close

```
wiki prd close <id>
```

Refuses if any linked slice is not in `closed` status. Transitions PRD to
`closed`.

## Other commands

```
wiki prd show <id>             # display full PRD with current field values
wiki prd set <id> --field status in-progress  # manual status override
```
