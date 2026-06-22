@.ralph/plan.md @.ralph/progress.md

You are in a Ralph loop. Each iteration is a fresh context window.

1. Read .ralph/plan.md (especially **Guardrails** and **Environment**) and .ralph/progress.md.
2. Run: git log --oneline -10
3. Choose the HIGHEST PRIORITY incomplete item from .ralph/items.json.
4. Before changing anything, search the codebase — don't assume it's unimplemented.
5. Implement it fully — no placeholders, no stubs. Respect the HARD guardrails: never
   reintroduce session / gates / red-green / next-phase / Obsidian coupling. "create
   stays pure" is about qmd indexing only — the PRD↔slice backlink IS allowed.
6. Build, typecheck, test: `bun run build && bunx tsc --noEmit && bun test tests/`
7. If anything fails, fix it before moving on.
8. Append to .ralph/progress.md: what you did, key decisions, files changed.
9. Flip your item's "done" to true in .ralph/items.json (jq).
10. git add the changed files and commit with a descriptive message. Vault changes
    (project wiki-v2, under /Users/tothemoon/Knowledge) commit there separately.

ONE item per iteration. Do NOT skip ahead.

When ALL items in items.json are done and verification is green:
  <promise>COMPLETE</promise>
