# wiki

Knowledge + delivery system over a locked Obsidian vault. Single CLI is the only writer; humans edit in Obsidian. v2 of `knowledge-wiki-system` — separate repo, clean break.

## Status

**Early build.** Architecture is fully decided; implementation has not started. PRD-001 is the first delivery slice.

## Design source of truth

All architectural decisions live in the vault, not this repo:

- **Planning project:** `~/Knowledge/projects/wiki-v2/`
- **ADRs (16):** `~/Knowledge/projects/wiki-v2/adrs/`
- **Docs:** `~/Knowledge/projects/wiki-v2/docs/`
- **Templates:** `~/Knowledge/_templates/` (source of truth — this repo's `templates/` is the bundled-with-CLI copy)

Read the ADRs in order before changing the architecture. Read relevant docs before writing prose about the system.

## Predecessor (v1)

`~/Dev/code-forge/knowledge-wiki-system/` remains operational during v2 development. Cutover plan in ADR-0016.

## Layout

```
.
├── src/             CLI source (Bun + TypeScript)
├── skills/          Skill bundle (the /wiki skill + supporting docs)
│   └── wiki/
│       ├── SKILL.md
│       ├── PHASE-*.md   (forks of Matt Pocock's writing skills)
│       └── ADMIN-*.md   (bootstrap, migration)
├── templates/       Bundled artifact templates (PRD, slice, decision, handover)
├── tests/           Test fixtures + suites
└── README.md
```

## Hard rules (from ADRs — do not violate)

- **Vault is locked.** Agents do not write to the vault directly. All writes go through `wiki` CLI verbs. (ADR-0001)
- **One verb per artifact type.** Don't add verbs; add fields. (ADR-0015)
- **Templates carry schema in frontmatter.** Don't write artifacts without going through a schema. (ADR-0004)
- **TDD is structurally enforced.** Slice cannot close without recorded red→green logs. (ADR-0005)
- **Dedup gate runs before every PRD/slice/decision create.** No silent overwrites. (ADR-0010)
- **Artifact filenames are human-readable.** New artifacts use `ID-title-slug.md`; resolve by frontmatter ID, not by assuming `ID.md`.
- **Docs are nested by category.** Docs live in `docs/<category>/` where category is a locked set: `architecture`, `research`, `runbooks`, `specs`, `notes`, `legacy`. DOC ids stay globally unique per project. `wiki create doc --category <cat>` (defaults from `--type`).

## Development

Requires Bun >= 1.0.

```sh
bun install
bun run dev          # watch mode
bun run typecheck    # tsc --noEmit
bun test
bun run build        # produces dist/cli.js
```
