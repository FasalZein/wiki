---
name: wiki
description: "Manages wiki vault delivery workflow — PRDs, slices, ADRs/decisions, docs, TDD gates, handovers. Use when work touches the wiki vault, the repo carries a wiki:begin pointer block, the user asks to create/update/close delivery artifacts or recall project context, or the vault needs init, doctor, or sync."
---
# /wiki

A thin router for vault delivery work. It tells you *when* to act and *which*
skill to load; the `wiki` CLI owns all command syntax. Never restate flags here —
ask the CLI.

## Start here (every session)

1. `wiki status --with-doc` (add `--project <name>` if not in the repo) — prints the
   active phase, artifacts, next step, and the moment-of-action guidance for that phase.
   No session yet? Run `wiki session start --project <name>`. A new session starts in
   `ad-hoc` (no enforced workflow); set a phase with `wiki session set phase <plan|prd|slice|triage>`
   (or `wiki session start --phase <phase>`), then rerun step 1 to get phase guidance.
2. `wiki <verb> --help` — exact usage/flags/example before any call. `wiki --help` lists verbs.
3. Do what the phase guidance says. On resume, always re-read step 1 — never trust stale context.

Cold start — no session AND no `<!-- wiki:begin … -->` pointer block in AGENTS.md/CLAUDE.md:
check `wiki project list`, then bind the repo with `wiki project link` (create the project
first if it doesn't exist). Never guess a project name.

Doing vault setup, a health check, or format cleanup, not delivery work? Skip the
phase flow and run `wiki vault --help`, `wiki doctor`, or `wiki fmt` — admin commands
are self-describing.

## Output contract (non-negotiable)

Every artifact write goes through the `wiki` CLI into the vault — never GitHub Issues,
`docs/adr/`, a repo `CONTEXT.md`, or OS temp dirs, even when a loaded skill says to.
"Create an issue" becomes the matching `wiki create ...`; a glossary term or repo
`CONTEXT.md` entry becomes a vault doc. The vault is the only home for PRDs, slices,
decisions, docs, and handovers. This overrides any upstream skill you load.

Creation is one-shot: pass the authored body via `--body -` (stdin) so the artifact is
complete in a single command — `obsidian create` is never used. Later field edits are
first-class `wiki` verbs too (see below); drop to `obsidian` only for *body* edits.

## Phase routing

Flow: plan (grill) → prd → slice → red → green → close → handover. A PRD has many slices;
each runs red → green → close on its own. Triage fires whenever state is unclear and
chains back to plan if scope needs re-establishing. Skip plan when scope is already clear.

The phase guidance from step 1 names the skill to load for process depth
(`ad-hoc` has none — it just routes you to set a phase):
plan→`grill-with-docs`, slice/red/green→`to-slices` + `tdd`, handover→`handoff`.
Load it only for the phase you're in. (prd and triage are vault-native — no
upstream skill; the phase doc carries the method.)

## Mutating artifacts after creation

Frontmatter is the CLI's job — one validated call per intent. Never `obsidian
property:set`/`eval` for a field: it comma-corrupts list values and needs the desktop app.

- Set any field: `wiki set <id> <field> <value...>` — schema-validated, comma-safe,
  booleans/ints coerced. Close a PRD with `wiki set PRD-0001 status closed` (`wiki close`
  is slices only). Type is inferred from the id.
- Set `blocked_by`: `wiki block <id> --on <id> [--on <id>...]` — auto-wraps as `[[…]]`.
- Supersede an already-created artifact: `wiki supersede <oldId> --by <newId>`.
- Discover fields/enums before guessing a value: `wiki schema <type>`.
- Resolve an id to its file path: `wiki path <id>` (filenames are `ID-slug.md`).
- Add `--json` to these (and `create`/`next-id`) for `{id,…}` on stdout and
  `{error,field,expected}` on stderr — detect success/failure programmatically, never scrape prose.

Body edits (prose, checkboxes) are the one thing still done through Obsidian: `obsidian
append` or a targeted `eval` that edits in place — never rewrite or delete-and-recreate the
file. Before `wiki close`, tick every `## Todo` checkbox (`- [x]`) with a targeted `eval`;
the close gate blocks on unchecked items and lists them.

## Gates the CLI won't tell you

- Dedup: a *strong* near-duplicate now **blocks** create (exit ≠ 0). Read the match, then
  `--supersedes` it (this replaces it), `--related-to` it (genuinely adjacent), or
  `--force-new "<reason ≥30 chars>"`. Weak matches stay advisory. Never blind-override.
- A re-run gate saying "cannot red/green from status X" usually means the first run already
  succeeded — check `wiki status` before retrying or diagnosing.
- After creating, run `wiki sync` (the CLI reminds you) — search updates the index but does
  NOT re-embed, so new artifacts stay invisible to ranked search/dedup until a sync.
- Docs live only in the locked `docs/<category>/` folders (architecture, research, runbooks,
  specs, notes, legacy) — never invent a folder; an unfit doc goes in the closest locked one.
  `wiki doctor` flags any rogue folder or loose file under `docs/`.
- Obsidian must be running — the vault depends on it for rendering, Dataview, and Bases views.
- Don't skip TDD/review/close/handover gates.
