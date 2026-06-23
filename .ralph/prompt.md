@.ralph/plan.md @.ralph/progress.md

You are in a Ralph loop. Each iteration is a fresh context window.

1. Read .ralph/plan.md (especially **Guardrails** and **Environment**) and .ralph/progress.md.
2. Run: git log --oneline -10
3. Choose the HIGHEST PRIORITY incomplete item from .ralph/items.json (passes:false).
4. READ that item's injected source_doc — the full slice (SLICE-007N) and ADR-0036. The slice
   is the spec: it names the files, the approach, and the acceptance criteria.
5. Before changing anything, open the cited files and confirm current state — search the code,
   don't assume. If the code has drifted hard from the slice, STOP: write what you found to
   progress.md and do NOT guess.
6. Implement the item fully per its slice — no placeholders, no stubs. Respect the HARD
   guardrails in plan.md (create stays pure re index.md/qmd; summary is just a field; group is
   frontmatter not folders; SLICE-0074 edits template SOURCE only, never existing vault files).
7. Build, typecheck, test: `bun run build && bunx tsc --noEmit && bun test tests/`
8. If anything fails, fix it before moving on. Items 1/2/3 ADD tests; item 1 also fixes any
   existing fixtures that now miss the required summary.
9. Append to .ralph/progress.md: what you did, key decisions, files changed.
10. In .ralph/items.json, flip ONLY that item's "passes" to true (use jq). Never change any
    item's category, description, or steps.
11. git add the changed files and commit with a descriptive message.

ONE item per iteration. Do NOT skip ahead.

When ALL items in items.json pass and verification is green:
  <promise>COMPLETE</promise>
