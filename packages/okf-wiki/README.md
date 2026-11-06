# Isolated profile CLI

This private package runs directly from TypeScript sources with Node built-in
stripping (Node >=22.18). It does not use the installed legacy `wiki` binary.
Do not run the root build or install this CLI globally for development.

```sh
node packages/okf-wiki/bin/okf-wiki.js init /explicit/disposable/vault --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault init --json
WIKI_VAULT=/explicit/disposable/vault node packages/okf-wiki/bin/okf-wiki.js init --json
```

Only `init` is implemented in B01. The directory argument is an explicit vault
selection. `--vault` takes precedence over `WIKI_VAULT`; an init directory also
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
Schema validation, registry editing, note commands, and search belong to later slices.

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

## Verification

From the repository root:

```sh
OKF_TEST_PATTERN="okf:01" heavy -- bun run test:okf
heavy -- bun run typecheck:okf
```

The test runner reads `OKF_TEST_PATTERN` and passes its name-pattern option before
file arguments to Node. `verify:okf` checks this package and all its tests. The
existing `verify:next` wildcard also runs these tests, and its TypeScript project
includes this package source and tests. Full suites run at the batch gate, not
after every slice. Current process tests use disposable fixtures only.

### Planned `boot:okf` contract (B20, not executable yet)

There is **no boot script** in B01. Do not add a passing placeholder to the
manifest. B20 will supply `heavy -- bun run boot:okf`: start the source Node CLI
in temporary storage, run init/new/show/lint/index-check, assert their results,
clean up, and exit. Any search smoke must use isolated qmd state and explicitly
selected local models. This contract requires no root build, global install,
archive access, or blanket Git staging. Until then, `okf:01` provides the concrete
real-process init smoke, preservation checks, and refusal fixtures.
