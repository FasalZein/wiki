---
source: wiki-v2
---
# Admin: Vault Bootstrap Operations

Reference doc for vault management. Use these commands when bootstrapping a new machine, diagnosing drift, or managing plugin configs.

## `wiki vault init <path>`

Provisions a complete vault from scratch:

1. Creates directory tree: `projects/`, `_templates/`, `.obsidian/plugins/`, `.wiki/`, `.wiki/blessed-config/`
2. Writes `.gitignore` (excludes workspace files, `.smart-env/`, backup configs)
3. Runs `git init` if `.git/` doesn't exist
4. Downloads required plugins from GitHub releases into `.obsidian/plugins/`
5. Writes `community-plugins.json` listing enabled plugins
6. Writes `.wiki/plugin-lock.json` pinning resolved versions
7. Writes default `data.json` for each required plugin (from CLI-bundled defaults)
8. Copies templates from repo `templates/` to `<vault>/_templates/`
9. Writes `<vault>/.wiki/config.json` with default search preferences
10. Registers QMD collections with per-subfolder context annotations
11. Runs initial QMD indexing (`qmd update` + `qmd embed`)
12. Installs skill symlink into detected skills directory
13. Writes harness lock config (Claude Code deny patterns, Codex manual instructions)
14. Prints verification report

Safe on existing vaults — skips existing dirs, doesn't overwrite `.gitignore` or blessed configs.

Use `--plugin-source <dir>` for air-gapped installs (local plugin artifacts instead of GitHub).

## `wiki vault sync`

Idempotent re-install from the lockfile. Use on fresh clones or new machines.

1. Installs missing plugins at locked versions (skips existing correct-version)
2. Writes default configs for plugins missing `data.json`
3. Re-deploys templates from repo
4. Updates lockfile and `community-plugins.json`

Running sync twice produces identical results.

## `wiki vault doctor`

Reports drift without auto-fixing. Exit code 0 = clean, 1 = drift.

Checks (in order):
- **Missing required plugins** — `manifest.json` absent from `.obsidian/plugins/<id>/`
- **Version mismatch** — installed version differs from lockfile
- **Config drift** — `data.json` differs from blessed config (or CLI default if no bless)
- **Missing templates** — repo templates not present in `_templates/`
- **community-plugins.json mismatch** — list doesn't match installed plugins

Does NOT flag missing optional plugins (Tasks, Meta-Bind).

## `wiki vault config bless <plugin>`

Accepts the current `data.json` as the team default. Copies to `.wiki/blessed-config/<plugin>.json` (committed to git). After bless, doctor compares against the blessed version.

Use when you've intentionally customized a plugin and want the team to get your config.

## `wiki vault config reset <plugin>`

Reverts `data.json` to the last blessed version. Falls back to CLI-bundled default if no bless exists.

Use when you want to undo accidental config changes.

## Troubleshooting

**Doctor reports version mismatch:** Run `wiki vault sync` to re-install at locked versions.

**Doctor reports config drift:** Either `wiki vault config bless <plugin>` to accept the change, or `wiki vault config reset <plugin>` to revert.

**Doctor reports missing templates:** Run `wiki vault sync` to re-deploy.

**Plugin install fails (no network):** Use `wiki vault init --plugin-source <dir>` with a local directory containing pre-staged plugin artifacts.

**Skill symlink not found:** Manually symlink `<repo>/skills/wiki/` into your agent's skills directory.

## Other admin commands

### `wiki validate <artifact-file>`

Schema-checks a single artifact file. Reports missing required fields, invalid
status values, and type mismatches. Use after manual frontmatter edits or migration.

### `wiki next-id --project <name> --type <prd|slice|decision|handover>`

Returns the next available sequential ID for the given artifact type. Useful
when scripting bulk creation or verifying ID gaps.

### `wiki project create <name>` / `wiki project list`

Creates a new project directory structure under `projects/` or lists existing
projects. `create` provisions the standard artifact subdirectories (prds, slices,
decisions, handovers, docs). Artifact files are named `ID-title-slug.md` for human readability.
Docs are organized into category subfolders (`docs/architecture|research|runbooks|specs|notes|legacy/`),
created lazily as content is added.

### `wiki doc retitle <DOC-NNNN> --project <name> --title <t>` / `wiki doc recategorize <DOC-NNNN> --project <name> --category <c>`

Maintains an existing doc in place. `retitle` rewrites the title and re-slugs the
filename (staying in its current category); `recategorize` moves the file into
another locked category subfolder. Both preserve the DOC id and its `[[DOC-NNNN]]`
alias, so links keep resolving. Re-run `wiki vault sync` afterwards to refresh search.

## When to run

- **New machine:** `wiki vault init <path>`
- **Fresh clone:** `wiki vault sync`
- **Before commit:** `wiki vault doctor`
- **After plugin customization:** `wiki vault config bless <plugin>`
- **Undo config change:** `wiki vault config reset <plugin>`
