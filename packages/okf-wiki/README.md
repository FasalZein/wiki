# Isolated profile CLI

This private package runs directly from TypeScript sources with Node built-in
stripping (Node >=22.18). It does not use the installed legacy `wiki` binary.
Do not run the root build or install this CLI globally for development.

```sh
node packages/okf-wiki/bin/okf-wiki.js init /explicit/disposable/vault --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault init --json
WIKI_VAULT=/explicit/disposable/vault node packages/okf-wiki/bin/okf-wiki.js init --json
```

Implemented commands are `init`, `type list`, `type add`, and the registry/frontmatter
portion of `lint`. The init directory argument is an explicit vault selection. `--vault` takes precedence over `WIKI_VAULT`; an init directory also
takes precedence over the environment. Conflicting flag and positional
directories fail with exit 2. There is no default vault. Relative vault locations
resolve from the current working directory. Parent filesystem aliases resolve
to a canonical vault root; the root itself and managed entries cannot be symlinks.
This protects a trusted local filesystem, not against hostile concurrent swaps.

## Initialization and preservation

A new or empty target receives `.wiki/config.json` with profile `wiki-okf`, version
1; seven registry JSON records under `.wiki/types/`; `.wiki/tmp/` and `.wiki/locks/`;
a root `index.md` with `okf_version: "0.2"`; an empty `log.md`; and `.gitignore`
rules for scratch, locks, the search database, and SQLite sidecars. No scope
directories are needed until content exists. Init does not initialize Git, import
search/native/model dependencies, load models, or write global configuration.

Registry files are editable data, not a fixed type universe. Each record has
`name`, `folder`, a draft-2020-12 `frontmatterSchema`, `requiredHeadings` as
`{level, text}` entries, and a literal Markdown body `template`. An absent `scopes`
allows all supported scopes. Templates do not execute or interpolate code.
The source schema includes retained-asset metadata for later capture commands.
Registry validation and exclusive scaffolding are implemented. Note writes and search
belong to later slices.

Init publishes complete files exclusively, with the configuration last as the
completion marker. A compatible repeat checks the managed layout and leaves
all bytes unchanged, including edited registries and navigation. It does not
reseed missing types or validate authored registry contents. Unsupported profiles
or versions fail with exit 5; malformed configuration and incomplete layouts
fail with exit 6. Nonempty foreign targets fail without conversion. A missing
explicit selection or symlink target fails with exit 2. Errors under `--json`
use `{ok:false,error:{code,message}}`; success uses `{ok:true,vault:{root}}`.
Human errors go to stderr. Unexpected internal failures use exit 1.

Initialization is not a multi-file transaction. After interruption, retry reports
the missing or malformed managed paths and does not repair or overwrite them.
Inspect retained files before choosing a fresh empty destination or recovering
manually. Do not treat a config-free partial vault as an empty target.

## Registry and frontmatter validation

Install the package-local, pinned dependencies without changing the root dependency
set or lockfile:

```sh
heavy -- npm ci --prefix packages/okf-wiki --ignore-scripts
```

This package owns its npm lockfile. Ajv evaluates draft-2020-12 schemas with
`ajv-formats` date-time validation. YAML uses the core data schema, preserves
timestamps as strings, rejects unknown tags and duplicate keys, and has no parse
cache. Plain `---` delimiters cannot select a language engine.

```sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault type list --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault type add glossary --folder glossary --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault lint --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault lint projects/wiki/glossary/terms.md --json
```

The registry, not CLI source, defines accepted type names. Each schema may use
fragment-local JSON pointers and anchors, including `$defs`. Remote/relative-file
references and external schema identifiers are refused without network access.
Registry records reject unknown configuration keys. Templates are literal Markdown
body text, never executed or interpolated; executable/interpolation markers and
embedded frontmatter are refused. Required headings must appear in the template.
Folders must be safe, non-reserved names and cannot overlap in allowed scopes.
Exact `scopes` restrictions are optional; absent means all supported scopes.

`type list` returns names, folders, required fields/headings, and optional scopes.
`type add` publishes a complete JSON scaffold exclusively and records a type-added
log entry. It refuses existing files, does not migrate notes, and installs no hooks.
Review its JSON and run whole-vault lint before committing a registry change.
A later log failure reports `written: true`, the published path, and its digest;
it does not remove the published scaffold or invent a successful log entry.

A custom schema can narrow the common profile but cannot remove required fields,
string/date-time contracts, tag casing, lifecycle value syntax, or the flat-data
restriction. Source notes still require resource and retrieval metadata. Extra
flat properties must be declared by the type schema. Validation never coerces
values or supplies defaults. Diagnostics sort by path, rule, and message and
include `path`, `rule`, `message`, and `fix`. Lint failures exit 1 with error code
`lint`; successful lint reports `checks: ["registry", "frontmatter"]`.

**Current boundary:** lint checks registry integrity and authored frontmatter,
including exact type scope restrictions. It does not yet check canonical folder
placement, body/headings, duplicate titles, lifecycle target references, links,
or generated indexes. A successful lint result is not yet full-product lint.
A path selection still validates the entire registry. Lint never rewrites files.

## Verification

From the repository root:

```sh
OKF_TEST_PATTERN="okf:01|okf:02" heavy -- bun run test:okf
heavy -- bun run typecheck:okf
```

The test runner reads `OKF_TEST_PATTERN` and passes its name-pattern option before
file arguments to Node. `verify:okf` checks this package and all its tests. The
existing `verify:next` wildcard also runs these tests, and its TypeScript project
includes this package source and tests. Full suites run at the batch gate, not
after every slice. Current process tests use disposable fixtures only.

### Planned `boot:okf` contract (B20, not executable yet)

There is **no boot script** yet. Do not add a passing placeholder to the
manifest. B20 will supply `heavy -- bun run boot:okf`: start the source Node CLI
in temporary storage, run init/new/show/lint/index-check, assert their results,
clean up, and exit. Any search smoke must use isolated qmd state and explicitly
selected local models. This contract requires no root build, global install,
archive access, or blanket Git staging. Until then, `okf:01` provides the concrete
real-process init smoke, preservation checks, and refusal fixtures.
