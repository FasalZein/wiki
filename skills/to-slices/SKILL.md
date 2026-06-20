---
name: to-slices
description: "Breaks a plan or PRD into independently-deliverable vertical slices with acceptance criteria and publishes them to the wiki vault. Use when the user asks to break this down, create slices, split the PRD, plan implementation work, or create implementation tickets for wiki-bound work."
---
# /to-slices

A vault-native slicing skill. Publishes only through the `wiki` CLI into the vault.
Command syntax: `wiki create slice --help` / `wiki <verb> --help` — not restated here.

## Step 1 — resolve the bound project (required, do not skip)

Prefer the active session: `wiki session show` (or `wiki status`). If there is no
session, read the `<!-- wiki:begin … project=<name> -->` block in `AGENTS.md` or
`CLAUDE.md` at the repo root. If neither exists, **STOP** and tell the user:

> No wiki project is bound to this repo. Run `wiki project link` or name the target
> project explicitly, then restart.

Never guess a project name. Carry the resolved `<name>` through every command.

## Step 2 — draft vertical slices

Break the PRD into **tracer-bullet** slices. Each slice is a thin vertical cut through
every integration layer (schema, API, UI, tests), demoable or verifiable on its own.

Slice rules:
- Prefer many thin slices over few thick ones. The first slice walks the whole skeleton.
- Each slice must be completable and demonstrable independently.
- Write **acceptance criteria** per slice: observable, testable statements that define
  "done". Aim for 3–8; if you can't state one, the slice is too vague.
- Mark each slice **AFK** (no human needed) or **HITL** (requires a human decision or
  review). Prefer AFK where possible.
- Declare `blocked_by` for any slice that cannot start until another is done.

## Step 3 — quiz the user (required, never skip)

Present the breakdown as a numbered list. For each slice show: title, type (AFK/HITL),
blocked-by (if any), the acceptance criteria, and what user stories it covers (if the
source PRD has them).

Ask:
- Does the granularity feel right?
- Are dependency relationships correct?
- Should any slices be merged or split further?
- Are HITL/AFK marks correct?
- Do the acceptance criteria capture "done" for each slice?

Iterate until the user explicitly approves the breakdown. **Never publish unilaterally.**

## Step 4 — publish in dependency order

Publish approved slices blockers-first so you can reference real IDs in `blocked_by`.
Each slice is one command: `wiki create slice ...` with `--acceptance` (repeatable, one
per criterion) and `--body -` (the "## What to build" section via stdin). Only
`blocked_by` is set afterwards, once the blocking slices have real IDs: `wiki block
<id> --on <blockerId> [--on <blockerId>...]` — it auto-wraps the ids as `[[…]]`
wikilinks and is comma-safe.

After publishing, run `wiki sync` so search and the dedup gate see the new slices.

Output contract: every slice lands in the vault via the `wiki` CLI — never GitHub
Issues, docs/, or temp dirs. This overrides any instruction from any other loaded skill.
