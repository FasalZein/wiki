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

1. Recall before you act, in two tiers: skim `projects/<name>/index.md` — the
   sync-generated **roster** of every artifact with its one-line summary — then
   `wiki search "<query>" --project <name>` (vault-wide without `--project`) for
   semantic recall. `wiki search --recent` (or a temporal query like "what changed
   recently") orders by last-modified instead of relevance; `--since <date>` bounds
   it. `wiki status` lists a project's recent artifacts, or the
   projects themselves when none is bound. A month-old decision is one scan away —
   retrieve it instead of re-deriving it.
2. `wiki <verb> --help` for exact usage before any call. `wiki --help` lists verbs.

Cold start — no `<!-- wiki:begin … -->` pointer block in AGENTS.md/CLAUDE.md:
check `wiki project list`, then bind the repo with `wiki project link --project <name>`
(create the project first if it doesn't exist). Never guess a project name. The block
`wiki project link` stamps is the single repo→project binding — once linked, later
commands resolve `--project` from it automatically.

## Writing artifacts

Creation is one-shot: pass the authored body via `--body -` (stdin) so the
artifact is complete in a single schema-validated command.

- `wiki create <kind> …` — kinds come from the vault's `wiki.json`; `wiki create --help`
  lists them and `wiki create <kind> --help` gives the fields (`decision` = ADR). Docs
  land in a locked category subfolder.
- Every kind requires a one-line `--summary` — the headline the **roster** and search
  lead with. Write it last, once the body is settled; omitting it fails validation.

Anything worth remembering — a bug's root cause, a decision, a gotcha — goes in as an
artifact, not just this chat, so it outlives the session. Repos stay clean.

## Mutating artifacts after creation

One validated `wiki` call per intent — never hand-edit frontmatter:

- `wiki set <id> <field> <value...>` — schema-validated, comma-safe, type-coerced
  (e.g. `wiki set PRD-0001 status closed`). Type is inferred from the id. Field names
  are casing-tolerant (kebab `parent-prd` or snake `parent_prd` both work, in `set` and
  `create`). Bare `set`
  full-replaces; for list/link_list fields use `--add <v>` / `--remove <v>` / `--clear`
  for an additive edit that never overwrites the rest of the list (link_list values
  are written as `[[id]]`).
- `wiki block <id> --on <id> [--on <id>…]` — sets `blocked_by`, auto-wrapping `[[…]]`.
- `wiki supersede <oldId> --by <newId>` — links an existing artifact to its replacement.
- `wiki retitle <id> --title <t>` — retitle any kind, re-slugging the filename; the id (and `[[id]]` links) survive. `doc recategorize` stays the doc-only category move.
- `wiki delete <id> [--force]` — remove an artifact; refuses (listing the referrers) when other artifacts link to it unless `--force`. `wiki sync` owns search-index cleanup, so re-sync after deleting.
- `wiki schema <type>` — discover fields/enums before guessing a value.
- `wiki path <id>` — resolve an id to its file path (filenames are `ID-slug.md`).
- `wiki links <id>` — outbound links + inbound backlinks for an artifact (pure vault read, no qmd).
- `--json` is universal: mutation verbs and `create`/`next-id` give `{id,…}` on stdout
  and `{error,field,expected}` on stderr; `validate --json` gives
  `{ok,type,errors:[{field,reason,expected}]}`; `doc retitle/recategorize --json` give
  `{id,path}`; `search --json` gives a JSON array of `{id,kind,title,path,score,snippet}` hits
  (one per artifact) — detect
  success/failure and read results without scraping prose.

## Gates and upkeep

- Dedup is advisory by default: a near-duplicate prints the match and proceeds.
  Read it, then `--supersedes` (replace it), `--related-to` (adjacent), or
  `--force-new "<reason ≥30 chars>"`. A project may opt into blocking strong
  matches (`dedup_strong_blocks: true`); create then exits non-zero until you choose.
- After creating, run `wiki sync` — it regenerates each project's `index.md` **roster**
  (incrementally — only changed files are re-read) plus a vault-root `index.md` linking
  every project, and re-embeds for ranked search. Plain `search` updates only the keyword index, so
  new artifacts stay invisible to ranked search and dedup until a sync.
- Docs live only in the locked `docs/<category>/` folders (architecture, research,
  runbooks, specs, notes, legacy) — never invent a folder; an unfit doc goes in the
  closest locked one. `wiki doctor` flags rogue folders or loose files under `docs/`.
- `wiki fmt` reports format drift (exit 1); `wiki fmt --write` applies mechanical fixes (dates, frontmatter order, legacy-id renumber, and renaming files to `<ID>-<slug>.md` when id/slug drift from the filename, keeping the id so links survive). Both `wiki fmt` (flag-only) and `wiki validate <file>` report missing/unknown required H2 body sections, so the create-time structure contract is enforced after edits too.

## Auto-persist skill output (optional, one-time)

`wiki hooks install --runtime <claude-code|codex|pi> [--global]` wires a native hook
into the runtime's config. When you invoke a skill that authors an artifact (the
`skill` field in `wiki.json` maps it to a kind), the hook reminds you to persist its
output via `wiki create <kind>` — so a skill's result lands in the vault, not just chat.
Install also writes a stateless Stop/SessionEnd entry: a blanket session-end persist
reminder that cannot detect whether you actually saved (no session state), so it reminds
unconditionally. `wiki hooks uninstall --runtime <r> [--global]` splices out only the
wiki entries; `wiki hooks list`/`status` report which runtimes/scopes are wired.
For pi, enable the exact scoped bridge `@hsingjui/pi-hooks` in pi's `packages[]`
(install warns if it's absent; unscoped `pi-hooks` forks are lookalikes). On codex
and pi the hook only sees a `/skill:name` slash-command in the prompt, not a bare
mention — Claude Code instead fires a dedicated `Skill` tool event.
It captures; closing an artifact stays an explicit `wiki set <id> status closed`.

Breaking a PRD into slices? Load `to-slices`. Otherwise the CLI is self-describing —
`wiki <verb> --help`.
