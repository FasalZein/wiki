# wiki

Knowledge + delivery system over a locked Obsidian vault. The `wiki` CLI is the
only writer; humans read and edit in Obsidian. Agents drive the full delivery
workflow — PRDs, vertical slices, TDD gates, ADRs, docs, and session handovers —
and every artifact lands in the vault, never in repos or issue trackers.

## How it works

- **The vault is the single source of truth.** One Obsidian vault (default
  `~/Knowledge`) holds every project's PRDs, slices, ADRs, docs, and handovers
  under `projects/<name>/`.
- **The CLI is a gate, not a CRUD wrapper.** ~16 workflow verbs enforce the
  delivery process (dedup checks, TDD red→green evidence, close gates, format
  drift). Anything an agent can already do well (reading, field edits) goes
  through the Obsidian CLI directly.
- **Obsidian is both editor and API.** All vault writes route through the
  Obsidian app's bundled CLI, so wikilinks, Dataview, and Bases views stay
  consistent. Obsidian must be running.
- **Search is delegated to [qmd](https://github.com/tobi/qmd)** — on-device
  hybrid search (BM25 + vectors + reranking) over the vault.
- **A skill bundle** (`skills/`) teaches coding agents (Claude Code, etc.) when
  to use which verb.

## Requirements

| Dependency | Why | Notes |
|---|---|---|
| [Bun](https://bun.sh) ≥ 1.0 | Build + run the CLI | |
| [Obsidian](https://obsidian.md) | Vault rendering + the write API | Must be running when the CLI is used |
| Obsidian CLI on `PATH` as `obsidian` | All vault writes go through it | Bundled with the app — on macOS: `ln -s /Applications/Obsidian.app/Contents/MacOS/obsidian-cli /usr/local/bin/obsidian` |
| [qmd](https://github.com/tobi/qmd) | Semantic search (`wiki search`, `wiki sync`, dedup gate) | Override the binary with `QMD_COMMAND` |
| git (optional) | Vault backups | Pair with the `obsidian-git` plugin for auto-commits |

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

**1. Initialize the vault** (provisions folders, templates, and the plugin
manifest):

```sh
wiki vault init ~/Knowledge
```

**2. Point the CLI at the vault.** Default is `~/Knowledge`; override with
either the env var or a config file:

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
`AGENTS.md`/`CLAUDE.md` so agents auto-discover the project:

```sh
wiki project create myproj
wiki project link --project myproj --repo ~/code/myproj
```

**4. Install the agent skill bundle** (for Claude Code and friends):

```sh
npx skills add FasalZein/wiki -g
```

This installs three skills: `wiki` (the workflow router), `to-slices` (PRD →
vertical slices), and `handoff` (session handovers).

**5. Verify:**

```sh
wiki doctor          # vault health: plugins, templates, config drift
wiki status          # vault-wide phase + artifact overview
```

## Daily workflow

The delivery loop: **plan (grill) → prd → slice → red → green → close →
handover**. A PRD has many slices; each slice runs its own red→green→close.
Every verb prints exact usage with `wiki <verb> --help`; `wiki --help` lists
all verbs.

```sh
# start a session in the repo you're working in
wiki session start --project myproj --phase prd
wiki status --project myproj --with-doc     # phase guidance + next action

# create artifacts (dedup gate runs before every create)
wiki create prd   --project myproj --title "..." --body -
wiki create slice --project myproj --title "..." --acceptance "..." --body -
wiki create decision --project myproj --title "..." --body -    # ADR

# TDD gates — runs the project's test_command and records the evidence
wiki red   SLICE-0001 --project myproj    # requires ≥1 failing test
wiki green SLICE-0001 --project myproj    # requires those failures to pass
wiki close SLICE-0001 --project myproj --review-verdict pass

# end the session — prints a copy-paste prompt for the next session
wiki handover --project myproj --next-phase slice --produced "..." --open "..."
```

Gate rules worth knowing:

- `wiki red` needs the project's `_project.md` to declare a `test_command`.
- `wiki close` blocks until every `- [ ]` checkbox in the slice body's
  `## Todo` section is checked or removed — it lists the offenders.
- Prose/config-only slices set `tdd_exempt: true` with a written
  `tdd_exempt_reason` (≥ 20 chars) and skip red/green.
- `wiki close` is for slices only; PRDs close by setting their `status` field
  in Obsidian.

## Search and indexing

```sh
wiki search "auth flow" --project myproj   # ranked hybrid search
wiki sync --project myproj                 # re-embed after writing artifacts
```

`wiki search` refreshes the index but does **not** re-embed — run `wiki sync`
after publishing artifacts or new content stays invisible to ranked search and
weakens the dedup gate.

## Maintenance

```sh
wiki doctor                          # vault health report
wiki fmt --project myproj            # check mode: report format drift, exit 1 if any
wiki fmt --project myproj --write    # apply mechanical fixes (idempotent)
wiki vault sync ~/Knowledge          # push manifest config/plugins into the vault
wiki vault config bless dataview     # accept a plugin's current config as canonical
wiki validate <file>                 # check one artifact against its template schema
```

`wiki fmt` is the format gate: it normalizes dates, frontmatter order,
4-digit IDs (renumbering legacy 3-digit IDs vault-wide, references included),
strips leaked Templater blocks, and expands unrendered template sections.
Findings it won't auto-fix (missing required fields, prose in link lists) are
reported with hints for manual attention. Obsidian's own property editor
reintroduces date/order drift over time — rerunning `fmt --write` is the cure.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `KNOWLEDGE_VAULT_ROOT` | `~/Knowledge` (or config.toml `vault.root`) | Vault location |
| `OBSIDIAN_BIN` | `obsidian` | Obsidian CLI binary (tests point this at a mock) |
| `QMD_COMMAND` | `qmd` | Search binary override |

## Development

```sh
bun install
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
bun test tests/      # ALWAYS scope to tests/ — a bare `bun test` descends into qmd/
bun run build        # rebuild dist/cli.js (required before the installed binary updates)
```

Tests never touch a real vault or a running Obsidian: they run against a temp
vault with `OBSIDIAN_BIN` pointed at `tests/fixtures/mock-obsidian.sh`.

## Layout

```
.
├── src/             CLI source (Bun + TypeScript)
│   ├── cli/         dispatch, verbs, usage, phase guidance
│   ├── artifacts/   create/render/store, transitions (TDD gates), dedup
│   ├── schema/      template frontmatter schema loading
│   └── integrations/  obsidian + qmd subprocess layers
├── skills/          Agent skill bundle: wiki, to-slices, handoff (one SKILL.md each)
├── templates/       Bundled artifact templates (prd, slice, decision, doc, handover)
├── tests/           Suites + fixtures (mock Obsidian CLI)
└── dist/            Built CLI (bun run build)
```

## Hard rules (from ADRs — do not violate)

- **The vault is locked.** Agents never write vault files directly; all writes
  go through `wiki` verbs, which route through the Obsidian CLI. (ADR-0001, ADR-0017)
- **Gate-only CLI.** Don't add CRUD wrapper verbs; only wrap what agents can't
  do well themselves. (ADR-0019)
- **Templates carry schema in frontmatter.** No artifact is written without a
  schema. (ADR-0004)
- **TDD is structurally enforced.** A slice cannot close without recorded
  red→green logs (or a justified `tdd_exempt`). (ADR-0005)
- **Dedup gate before every PRD/slice/decision create.** No silent overwrites. (ADR-0010)
- **Resolve artifacts by frontmatter ID,** never by assuming `ID.md` —
  filenames are `ID-title-slug.md`.
- **Docs are nested by locked category:** `architecture`, `research`,
  `runbooks`, `specs`, `notes`, `legacy`. Never invent a new folder.

## Design source of truth

All architectural decisions live in the vault, not this repo:

- **Planning project:** `~/Knowledge/projects/wiki-v2/`
- **ADRs:** `~/Knowledge/projects/wiki-v2/adrs/` (ADR-0001 onward)
- **Docs:** `~/Knowledge/projects/wiki-v2/docs/`
- **Templates:** `~/Knowledge/_templates/` is the live copy; this repo's
  `templates/` is the bundled-with-CLI source.

Read the ADRs before changing the architecture.
