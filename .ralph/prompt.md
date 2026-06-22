@.ralph/plan.md @.ralph/progress.md

You are in a Ralph loop. Each iteration is a fresh context window.

1. Read .ralph/plan.md (especially **Guardrails** and **Environment**) and .ralph/progress.md.
2. Run: git log --oneline -10
3. Choose the HIGHEST PRIORITY incomplete item from .ralph/items.json.
4. READ that item's detailed plan file: .ralph/audit-plans/NNN-*.md (the path is in the item
   text). It is self-contained — files, exact code excerpts, steps, tests, and an escape hatch.
5. Before changing anything, open the cited files and confirm they still match the plan's
   excerpts. If the code has drifted substantially, or the plan's escape-hatch condition is
   true, STOP: write what you found to progress.md and do NOT guess.
6. Implement the item fully per its plan — no placeholders, no stubs. Respect the HARD
   guardrails in plan.md (never revive session/gates/red-green/phases/Obsidian coupling; add
   nothing new/abstract; "create stays pure" re qmd indexing; the PRD↔slice backlink stays).
7. Build, typecheck, test: `bun run build && bunx tsc --noEmit && bun test tests/`
8. If anything fails, fix it before moving on. Items 1/3/4/5 ADD tests — write them.
9. Append to .ralph/progress.md: what you did, key decisions, files changed.
10. Flip your item's "done" to true in .ralph/items.json (jq).
11. git add the changed files and commit with a descriptive message.

ONE item per iteration. Do NOT skip ahead.

When ALL items in items.json are done and verification is green:
  <promise>COMPLETE</promise>
