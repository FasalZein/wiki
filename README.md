# wiki

A config-driven **artifact store** and semantic **recall** tool over a vault of
plain Markdown. PRDs, vertical slices, ADRs, docs, and handoffs live in one
vault under `projects/<name>/` — never in code repos or issue trackers. The
`wiki` CLI creates and mutates them through schema-validated commands, and finds
them again with on-device hybrid search.

## How it works

- **The vault is the single source of truth.** One directory (default
  `~/Knowledge`) holds every project's artifacts as Markdown under
  `projects/<name>/`, version-controlled with git.
- **Artifact kinds are data, not code.** `wiki.json` defines each kind — its id
  prefix, folder, whether the dedup gate runs, and the skill that authors it.
  Add a kind there plus a `templates/<kind>.md`, and `wiki create <kind>` works
  with no code change. Ships with `prd`, `slice`, `decision` (ADR), `doc`, and
  `handoff`.
- **The CLI is a lean artifact store, not a workflow engine.** It wraps only what
  an agent can't do safely itself: schema-validated writes, id allocation,
  comma-safe field/link edits, dedup, format normalization, and search. There
  are no enforced phases, TDD gates, or session state — agents drive their own
  process.
- **Search is delegated to [qmd](https://github.com/tobi/qmd)** — on-device
  hybrid search (BM25 + vectors + reranking) over the vault.
- **A skill bundle** (`skills/`) teaches coding agents (Claude Code, Codex, pi)
  when to reach for which verb, and `wiki hooks` can wire a native hook that
  reminds the agent to persist a skill's output to the vault.

Obsidian is optional: the vault is plain Markdown with `[[wikilinks]]`, so you
can open it in Obsidian to browse, but the CLI writes files directly and depends
on nothing from it.

## Requirements

| Dependency | Why | Notes |
|---|---|---|
| [Bun](https://bun.sh) ≥ 1.0 | Build + run the CLI | |
| [qmd](https://github.com/tobi/qmd) | Semantic search (`wiki search`, `wiki sync`, dedup gate) | Override the binary with `QMD_COMMAND` |
| git | Vault history + backups | `wiki vault init` runs `git init` for you |

## Install

```sh
git clone https://github.com/FasalZein/wiki.git
cd wiki
bun install
bun run build      # produces dist/cli.js
bun link           # puts `wiki` on your PATH (~/.bun/bin/wiki)
```

The installed binary is the **built** `dist/cli.js` — after pulling or editing
source, run `bun run build` again or the installed `wiki` won't change.

## Setup

**1. Initialize the vault** (creates `projects/`, `.wiki/`, a `.gitignore`, and a
git repo):

```sh
wiki vault init ~/Knowledge
```

**2. Point the CLI at the vault.** Default is `~/Knowledge`; override with the
env var or a config file:

```sh
export KNOWLEDGE_VAULT_ROOT=~/Knowledge
```

or `~/.config/wiki/config.toml`:

```toml
[vault]
root = "/Users/you/Knowledge"

[research]
sources = ["~/.claude/artifacts/research"]   # optional extra search sources
```

**3. Create a project and bind your code repo to it.** Linking stamps a
`<!-- wiki:begin … project=<name> -->` pointer block into the repo's
`AGENTS.md`/`CLAUDE.md`. That block is the single repo→project binding — once
present, every command resolves `--project` from it automatically.

```sh
wiki project create myproj
wiki project link --project myproj --repo ~/code/myproj   # --repo defaults to cwd
```

**4. Install the agent skill bundle** (for Claude Code and friends):

```sh
npx skills add FasalZein/wiki -g
```

This installs one skill from this repo: `wiki` (the router under `skills/`). The
**authoring skills** that produce artifacts (`to-slices`, `handoff`, …) live in
your own skill collection, not here — `wiki.json` only names which of them the
persist hook recognizes. The hook maps each authoring skill to the kind it
writes:

<!-- skill-map:begin (generated from wiki.json — keep in sync) -->
- `to-prd` → authors `prd`
- `to-slices` → authors `slice`
- `grill-with-docs` → authors `decision`
- `handoff` → authors `handoff`
<!-- skill-map:end -->

**5. (Optional) Auto-persist skill output.** Wire native hooks so that when a
skill that authors an artifact runs, the agent is reminded to save its result to
the vault, plus a stateless session-end reminder:

```sh
wiki hooks install --runtime claude-code --global   # or codex / pi
wiki hooks status                                   # show which runtimes are wired
wiki hooks uninstall --runtime claude-code --global # remove only the wiki entries
```

**6. Verify:**

```sh
wiki doctor          # vault health: docs-structure + repo-binding drift
wiki status          # recent artifacts (lists projects when none is bound)
```

## Daily use

Every verb prints exact usage with `wiki <verb> --help`; `wiki --help` lists all
verbs. Recall first, then write.

```sh
# recall before acting
wiki search "auth flow" --project myproj   # ranked hybrid search, one line per artifact with id/kind/title (--json for a {id,kind,title,path,score,snippet} array)
wiki search "what changed recently" --recent # order by last-modified instead of relevance (--since 2026-06-01 to bound it)
wiki status --project myproj               # recent artifacts

# create — one-shot, body via stdin, schema-validated
wiki create prd      --project myproj --title "..." --body -
wiki create slice    --project myproj --title "..." --acceptance "..." --body -
wiki create decision --project myproj --title "..." --body -    # ADR
wiki create handoff  --project myproj --body -

# mutate existing artifacts (never hand-edit frontmatter)
wiki set      SLICE-0001 status closed       # schema-validated; type inferred from id (field names: kebab or snake)
wiki set      SLICE-0001 blocked_by --add SLICE-0002   # additive; --remove/--clear too (bare set replaces)
wiki block    SLICE-0002 --on SLICE-0001     # sets blocked_by, auto-wraps [[..]]
wiki supersede ADR-0003 --by ADR-0007
wiki retitle  SLICE-0001 --title "A clearer title"  # re-slugs filename; id + links survive
wiki delete   SLICE-0001                      # refuses if linked; --force to override (run sync after)
wiki path     PRD-0001                        # resolve id → file path
wiki links    PRD-0001                        # outbound links + inbound backlinks (no qmd)
wiki schema   slice                           # fields, types, enums before guessing

# index after writing
wiki sync --project myproj                    # re-embed so new artifacts are searchable
```

Good to know:

- **Dedup is advisory.** A near-duplicate prints the match and proceeds; resolve
  it with `--supersedes`, `--related-to`, or `--force-new "<reason>"`. A project
  can opt into blocking strong matches with `dedup_strong_blocks: true`.
- **`wiki search` does not re-embed.** Run `wiki sync` after writing, or new
  artifacts stay invisible to ranked search and the dedup gate.
- **Docs are nested by locked category** — `architecture`, `research`,
  `runbooks`, `specs`, `notes`, `legacy`. Never invent a folder.

## Maintenance

```sh
wiki doctor                          # vault health report
wiki fmt --project myproj            # check mode: report format drift, exit 1 if any
wiki fmt --project myproj --write    # apply mechanical fixes (idempotent)
wiki validate <file>                 # check one artifact against its template schema + required body sections (--json: {ok,type,errors})
```

`wiki fmt` normalizes dates, frontmatter order, and 4-digit IDs (renumbering
legacy 3-digit IDs of any kind vault-wide, references included), renames a file
to `<ID>-<slug>.md` when its id/slug drift from the filename (the id is kept so
`[[id]]` links survive), strips leaked Templater blocks, and expands unrendered
template sections. Findings it won't auto-fix (missing required fields, id-less
files, prose in link lists) are reported with hints.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `KNOWLEDGE_VAULT_ROOT` | `~/Knowledge` (or config.toml `vault.root`) | Vault location |
| `QMD_COMMAND` | `qmd` | Search binary override |

## Development

```sh
bun install
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
bun test tests/      # ALWAYS scope to tests/ — a bare `bun test` descends into qmd/
bun run build        # rebuild dist/cli.js (required before the installed binary updates)
```

Tests run against temp vaults; the dedup/search gate is driven by a fake `qmd`
(`QMD_COMMAND`) so they never need the real binary.

## Layout

```
.
├── src/             CLI source (Bun + TypeScript)
│   ├── cli/         dispatch, verbs, usage
│   ├── artifacts/   create/render/store, dedup, registry (kinds from wiki.json)
│   ├── schema/      template frontmatter schema loading
│   └── integrations/  qmd subprocess layer
├── skills/          Agent skill bundle: the `wiki` router (one SKILL.md)
├── templates/       Bundled artifact templates (prd, slice, decision, doc, handoff)
├── wiki.json        Artifact kind definitions (prefix, folder, dedup, skill)
├── tests/           Suites + fixtures
└── dist/            Built CLI (bun run build)
```

## Hard rules (from ADRs — do not violate)

- **Artifacts live in the vault,** never in code repos, GitHub Issues,
  `docs/adr/`, a repo `CONTEXT.md`, or temp dirs. (ADR-0001)
- **Lean CLI.** Don't add CRUD wrapper verbs; only wrap what agents can't do
  well themselves. (ADR-0019)
- **Kinds are configuration.** Templates carry their schema in frontmatter; a new
  kind is a `wiki.json` entry plus a `templates/<kind>.md`, no code. (ADR-0004, ADR-0035)
- **Dedup runs before every dedup-tracked create.** No silent duplicates. (ADR-0010)
- **Resolve artifacts by frontmatter ID,** never by assuming `ID.md` — filenames
  are `ID-title-slug.md`.

## Design source of truth

All architectural decisions live in the vault, not this repo:

- **Planning project:** `~/Knowledge/projects/wiki-v2/`
- **ADRs:** `~/Knowledge/projects/wiki-v2/adrs/` (ADR-0001 onward)
- **Docs:** `~/Knowledge/projects/wiki-v2/docs/`

Read the ADRs before changing the architecture.
