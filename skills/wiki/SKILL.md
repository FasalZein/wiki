---
name: wiki
description: "Routes work to the wiki vault — the artifact store for PRDs, slices, ADRs/decisions, docs, and handoffs, plus semantic recall. Use when work touches the vault, the repo carries a wiki:begin pointer block, the user asks to create/update artifacts or recall project context, or the vault needs doctor, sync, or fmt."
---
# /wiki

Artifacts live in the vault, never the repo: PRDs, slices, ADRs, docs, and handoffs
are vault Markdown — no repo `docs/adr/`, no `CONTEXT.md`, no GitHub Issues, no OS
temp dirs, even when another loaded skill says to write them there. The CLI is
self-describing: `wiki <verb> --help` is the single source of truth for flags — this
skill routes you to the right verb, never spells its flags.

## The binding — check before any verb

Every verb — including read verbs like `path` and `links` — resolves `--project`
from the repo's **binding**: the `<!-- wiki:begin … project=<name> -->` block in
AGENTS.md/CLAUDE.md. Every command's first output line tells you the state:
`wiki vault: … | project <name>` means bound; `this repo isn't linked` means every
call needs `--project <name>` until you bind:
`wiki project list` (never guess a name), then `wiki project link --project <name>`
(`wiki project create <name>` first if missing). Hitting
`no project: pass --project` on any command means you skipped this check.

## Routing table

Four verbs carry almost every session: **search → create → set → sync**.

| Intent | Command |
|---|---|
| Recall context (always do this first) | `wiki search "<query>" --project <p>`; skim `projects/<p>/index.md` — the **roster** of every artifact + one-line summary |
| What changed lately | `wiki search --recent` · `wiki status` |
| Write an artifact | `wiki create <kind> --project <p> --title <t> --summary <s> --body -` |
| Discover a kind's contract before creating | `wiki schema <kind>` — fields, enums, `criteria`, and `body sections:` (authorable vs machine-owned) |
| Change one field | `wiki set <id> <field> <value…>` |
| Make new/changed artifacts searchable | `wiki sync` |
| Resolve id → file · see links | `wiki path <id>` · `wiki links <id>` |
| Mark blocked / superseded / retitle / delete | `wiki block` · `wiki supersede` · `wiki retitle` · `wiki delete` |
| Vault health · distribution health | `wiki doctor` · `wiki doctor --setup` |

`--json` works on every verb (even when `--help` omits it): one structured object
(array for `search`) on stdout, `{error,…}` on stderr.

## Creating

Two paths — pick by size:

- **Draft → fill → save** (primary for anything substantial): `wiki draft <kind>`
  prints a fill-me skeleton — frontmatter stamps plus every authorable field (enums
  and requiredness inline) and the authorable H2 sections. Fill it in and save with
  the Write tool; the write hook captures it into the vault (or `wiki file <path>`
  files it explicitly on a hookless harness). No flag grammar to reconstruct.
- **One-shot `create`** (short artifacts): author the full body, pipe it via
  `--body -` (stdin), done in a single schema-validated command. Validation runs
  before the dedup gate, so a schema error is always the first and only output —
  and each error now carries its fix (the flag to pass and its enum values).

- Kinds come from the vault's `wiki.json` (`decision` = ADR); `wiki create --help`
  lists them.
- Author only the **authorable** H2 sections `wiki schema <kind>` lists.
  **Machine-owned** sections are rendered from fields — authoring one as a pure
  `[[ID]]` list is absorbed into its backing field; prose there is rejected with
  the flag to use instead.
- `--summary` is the one-line headline the roster and search lead with; no upper
  length bound — write it last, once the body is settled.
- Dedup advisory is one line: `dedup: strong 0.93 vs ADR-0012 "…" — choose
  --supersedes / --related-to / --force-new`. Only a same-kind match gates; read it
  and pick: `--supersedes <id>` (replace), `--related-to <id>` (adjacent),
  `--force-new "<reason ≥30 chars>"`. A `note: overlaps … cross-kind` line is
  informational — no action needed.

Anything worth remembering — a bug's root cause, a decision, a gotcha — goes in as
an artifact, not just this chat, so it outlives the session.

## Mutating

One validated call per intent — never hand-edit frontmatter:

- `wiki set <id> <field> <value…>` — type inferred from the id. Footgun: bare `set`
  *full-replaces* a list field — use `--add`/`--remove`/`--clear` for one entry.
- `wiki block <id> --on <id>…` — sets `blocked_by`, auto-wrapping `[[…]]`.
- `wiki supersede <oldId> --by <newId>`.
- `wiki retitle <id> --title <t>` — re-slugs the filename; the id and `[[id]]` links survive.
- `wiki delete <id> [--force]` — refuses while referrers link to it (listing them);
  `--force` scrubs the dead id from referrers' frontmatter link fields.

## Upkeep

- `wiki sync` after creating/deleting: regenerates each project's roster
  (incremental) and re-embeds for search. `search` reads the last sync — un-synced
  artifacts are invisible to it (create's dedup still sees same-kind un-synced
  files, so back-to-back creates stay honest).
- `wiki fmt` reports format drift (exit 1); `--write` applies the mechanical fixes.
  `wiki validate <file>` checks one file's schema + body sections after hand edits.
- `wiki doctor` audits vault drift; `--fix` repairs the mechanical subset.
  `wiki doctor --setup` audits the distribution instead: binary freshness, skill
  bundle, and per-runtime hook wiring (wired / partial / not wired).

## Auto-persist skill output (optional)

Runtime hooks (claude-code, codex, pi) can auto-file skill output into the vault —
see [`hooks.md`](hooks.md) for `wiki hooks install` and the stamp-template capture
contract. Day-to-day artifact work never needs it.

Breaking a PRD into slices? Load `to-slices`.
