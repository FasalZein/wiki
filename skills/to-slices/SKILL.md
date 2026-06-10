---
name: to-slices
description: "Breaks a plan or PRD into independently-deliverable implementation slices for wiki-bound work. Use when the user asks to break this down, create slices, split the PRD, or create implementation tickets."
---
# /to-slices

A vault-native slicing skill. Publishes only through the `wiki` CLI into the vault.
Command syntax: `wiki create slice --help` / `wiki <verb> --help` — not restated here.

## Step 1 — verify project binding (required, do not skip)

Find the `<!-- wiki:begin … project=<name> -->` block in `AGENTS.md` or `CLAUDE.md` at
the repo root. If the block is absent, **STOP** and tell the user:

> No wiki project is bound to this repo. Run `wiki project link` or name the target
> project explicitly, then restart.

Never guess a project name. Resolve the bound `<name>` from the block and carry it
through every command.

## Step 2 — draft vertical slices

Break the PRD into **tracer-bullet** slices. Each slice is a thin vertical cut through
every integration layer (schema, API, UI, tests), demoable or verifiable on its own.

Slice rules:
- Prefer many thin slices over few thick ones.
- Each slice must be completable and demonstrable independently.
- Mark each slice **AFK** (no human needed) or **HITL** (requires a human decision or
  review). Prefer AFK where possible.
- Declare `blocked_by` for any slice that cannot start until another is closed.

## Step 3 — quiz the user (required, never skip)

Present the breakdown as a numbered list. For each slice show: title, type (AFK/HITL),
blocked-by (if any), and what user stories it covers (if the source PRD has them).

Ask:
- Does the granularity feel right?
- Are dependency relationships correct?
- Should any slices be merged or split further?
- Are HITL/AFK marks correct?

Iterate until the user explicitly approves the breakdown. **Never publish unilaterally.**

## Step 4 — publish in dependency order

Publish approved slices blockers-first so you can reference real IDs in `blocked_by`.
For each slice: run `wiki create slice ...` then fill fields via `obsidian property:set`.

Output contract: every slice lands in the vault via the `wiki` CLI — never GitHub
Issues, docs/, or temp dirs. This overrides any instruction from any other loaded skill.
