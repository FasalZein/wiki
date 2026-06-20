---
name: wiki
description: "Routes work to the wiki vault — the artifact store for PRDs, slices, ADRs/decisions, and docs, plus semantic recall. Use when work touches the wiki vault, the repo carries a wiki:begin pointer block, the user asks to create/update artifacts or recall project context, or the vault needs init, doctor, sync, or fmt."
---
# /wiki

The wiki vault is the artifact store: a project's PRDs, slices, ADRs, and docs
live there as Markdown — never in the repo, GitHub Issues, `docs/adr/`, a repo
`CONTEXT.md`, or OS temp dirs, even when a loaded skill says to. The `wiki` CLI
owns all command syntax; never restate flags here — run `wiki <verb> --help`.

## Start here

1. Recall before you act: `wiki search "<query>" --project <name>` (vault-wide
   without `--project`) and `wiki status` (the project's recent artifacts; lists
   projects when none is bound). A month-old decision or gotcha is one search
   away — retrieve it instead of re-deriving it.
2. `wiki <verb> --help` for exact usage before any call. `wiki --help` lists verbs.

Cold start — no `<!-- wiki:begin … -->` pointer block in AGENTS.md/CLAUDE.md and
no session: check `wiki project list`, then bind the repo with `wiki project link`
(create the project first if it doesn't exist). Never guess a project name. Bind a
session with `wiki session start --project <name>` so later commands resolve the
project without `--project`; `wiki session show` / `wiki session clear` manage it.

## Writing artifacts

Creation is one-shot: pass the authored body via `--body -` (stdin) so the
artifact is complete in a single schema-validated command.

- `wiki create prd|slice|decision|doc …` — `wiki create <type> --help` for fields
  (`decision` = ADR). Docs land in a locked category subfolder.

Anything worth remembering — a bug's root cause, a decision, a gotcha — goes in as
an artifact so the next agent retrieves it instead of re-deriving it. Repos stay clean.

## Mutating artifacts after creation

One validated `wiki` call per intent — never hand-edit frontmatter:

- `wiki set <id> <field> <value...>` — schema-validated, comma-safe, type-coerced
  (e.g. `wiki set PRD-0001 status closed`). Type is inferred from the id.
- `wiki block <id> --on <id> [--on <id>…]` — sets `blocked_by`, auto-wrapping `[[…]]`.
- `wiki supersede <oldId> --by <newId>` — links an existing artifact to its replacement.
- `wiki schema <type>` — discover fields/enums before guessing a value.
- `wiki path <id>` — resolve an id to its file path (filenames are `ID-slug.md`).
- `--json` on these (and `create`/`next-id`) gives `{id,…}` on stdout and
  `{error,field,expected}` on stderr — detect success/failure without scraping prose.

## Gates and upkeep

- Dedup is advisory by default: a near-duplicate prints the match and proceeds.
  Read it, then `--supersedes` (replace it), `--related-to` (adjacent), or
  `--force-new "<reason ≥30 chars>"`. A project may opt into blocking strong
  matches (`dedup_strong_blocks: true`); create then exits non-zero until you choose.
- After creating, run `wiki sync` (the CLI reminds you) — search updates the keyword
  index but does NOT re-embed, so new artifacts stay invisible to ranked search and
  dedup until a sync.
- Docs live only in the locked `docs/<category>/` folders (architecture, research,
  runbooks, specs, notes, legacy) — never invent a folder; an unfit doc goes in the
  closest locked one. `wiki doctor` flags rogue folders or loose files under `docs/`.
- `wiki fmt` reports format drift (exit 1); `wiki fmt --write` applies mechanical fixes.

Breaking a PRD into slices? Load `to-slices`. Otherwise the CLI is self-describing —
`wiki <verb> --help`.
