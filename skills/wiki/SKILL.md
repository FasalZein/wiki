---
name: wiki
description: "Routes work to the wiki vault — the artifact store for PRDs, slices, ADRs/decisions, and docs, plus semantic recall. Use when work touches the wiki vault, the repo carries a wiki:begin pointer block, the user asks to create/update artifacts or recall project context, or the vault needs init, doctor, sync, or fmt."
---
# /wiki

The wiki vault is the artifact store: a project's PRDs, slices, ADRs, and docs
live there as Markdown — never in the repo, GitHub Issues, `docs/adr/`, a repo
`CONTEXT.md`, or OS temp dirs, even when a loaded skill says to. The `wiki` CLI is
self-describing: it owns all command syntax, so `wiki <verb> --help` is the single
source of truth for flags — this skill routes you to the right verb, never spells its flags.

## Start here

1. Recall before you act, in two tiers: skim `projects/<name>/index.md` — the
   sync-generated **roster** of every artifact with its one-line summary — then
   `wiki search "<query>" --project <name>` (vault-wide without `--project`) for
   semantic recall. `wiki search --recent` (or a temporal query like "what changed
   recently") orders by last-modified instead of relevance; `--since <date>` is its own
   recency filter (newer-than, independent of `--recent`). `wiki status` lists a project's recent artifacts, or the
   projects themselves when none is bound. A month-old decision is one scan away —
   retrieve it instead of re-deriving it.
2. `wiki --help` lists verbs; `wiki <verb> --help` gives exact usage before any call.

Cold start — no `<!-- wiki:begin … -->` pointer block in AGENTS.md/CLAUDE.md:
check `wiki project list`, then bind the repo with `wiki project link --project <name>`
(create the project first if it doesn't exist). Never guess a project name. The block
`wiki project link` stamps is the single repo→project binding — once linked, later
commands resolve `--project` from it automatically.

## Writing artifacts

Creation is one-shot: pass the authored body via `--body -` (stdin) so the
artifact is complete in a single schema-validated command.

- `wiki create <kind> …` — kinds come from the vault's `wiki.json` (`decision` = ADR). A
  branch section's **buckets** double as create-names: `wiki create <bucket>` files into that
  bucket's subfolder (e.g. `wiki create architecture` → `docs/architecture/`), or pass
  `--category <bucket>` to a section kind (`wiki create doc --category architecture`).
  Buckets are config-declared in `wiki.json`, not hardcoded; `wiki schema <bucket>` shows a
  bucket's `criteria` (the what-goes-where signal).
- Every kind requires a one-line `--summary` — the headline the **roster** and search
  lead with. Write it last, once the body is settled; omitting it fails validation.

Anything worth remembering — a bug's root cause, a decision, a gotcha — goes in as an
artifact, not just this chat, so it outlives the session. Repos stay clean.

## Mutating artifacts after creation

One validated `wiki` call per intent — never hand-edit frontmatter:

- `wiki set <id> <field> <value...>` — schema-validated; type inferred from the id. The one
  footgun `--help` won't warn you about: bare `set` *full-replaces* a list field, so use
  `--add`/`--remove`/`--clear` to edit one entry without wiping the rest.
- `wiki block <id> --on <id> [--on <id>…]` — sets `blocked_by`, auto-wrapping `[[…]]`.
- `wiki supersede <oldId> --by <newId>` — links an existing artifact to its replacement.
- `wiki retitle <id> --title <t>` — retitle any kind, re-slugging the filename; the id (and `[[id]]` links) survive. `doc recategorize` stays the doc-only category move.
- `wiki delete <id> [--force]` — remove an artifact; refuses (listing the referrers) when other artifacts link to it. `--force` deletes anyway and scrubs the dead id out of those referrers' frontmatter link fields; body prose mentions are reported, not rewritten. `wiki sync` owns search-index cleanup, so re-sync after deleting.
- `wiki schema <kind|bucket>` — discover fields/enums before guessing a value; a bucket
  also prints its `criteria`.
- `wiki path <id>` — resolve an id to its file path (filenames are `ID-slug.md`).
- `wiki links <id>` — outbound links + inbound backlinks for an artifact (pure vault read, no qmd).
- `--json` is universal — pass it to any verb to get one structured object (or array, for
  `search`) on stdout and a `{error,…}` object on stderr, so you detect success and read
  results without scraping prose. Not every verb's `--help` advertises `--json`; it still works.

## Gates and upkeep

- Dedup is advisory by default: a near-duplicate prints the match and proceeds.
  Read it, then `--supersedes` (replace it), `--related-to` (adjacent), or
  `--force-new "<reason ≥30 chars>"`. A project may opt into blocking strong
  matches (`dedup_strong_blocks: true`); create then exits non-zero until you choose.
- After creating, run `wiki sync` — it regenerates each project's `index.md` **roster**
  (incrementally — only changed files are re-read) plus a vault-root `index.md` linking
  every project, and re-embeds for ranked search. `search` is a pure read against the
  last `wiki sync`: it neither refreshes nor embeds, so new artifacts stay invisible to
  search and dedup until a sync. Search warns and skips any project collection that was
  never synced.
- Docs live in the config-declared `docs/<bucket>/` subfolders the vault's `wiki.json`
  declares (default buckets: architecture, research, runbooks, specs, notes, legacy) —
  never invent a folder; an unfit doc goes in the closest declared bucket. `wiki doctor`
  flags undeclared folders or loose files under a branch section.
  `wiki doctor --setup` checks distribution health instead of vault drift: binary freshness (source changed since the last `bun run build`), skill-bundle presence, and whether the persist hook is wired in any runtime. `wiki doctor --fix` repairs what is mechanical — duplicate ids (canonical keeps the id, the rest get a fresh one) plus the fixes `wiki fmt --write` applies — then re-audits, leaving only drift that needs a human (dangling links, repo bindings).
- `wiki fmt` reports format drift (exit 1); `wiki fmt --write` applies mechanical fixes (dates, frontmatter order, legacy-id renumber with in-project reference rewrite, and renaming files to `<ID>-<slug>.md` when id/slug drift from the filename, keeping the id so links survive). Both `wiki fmt` (flag-only) and `wiki validate <file>` report missing/unknown required H2 body sections, so the create-time structure contract is enforced after edits too.

## Auto-persist skill output (optional)

Wiring a runtime hook so skill output auto-files into the vault is a one-time setup
branch — see [`hooks.md`](hooks.md) for `wiki hooks install` and the stamp-template
capture contract. Day-to-day artifact work never needs it.

Breaking a PRD into slices? Load `to-slices`.
