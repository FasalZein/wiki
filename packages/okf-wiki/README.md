# Isolated profile CLI

This private package runs directly from TypeScript sources with Node built-in
stripping (Node >=22.18). It does not use the installed legacy `wiki` binary.
Do not run the root build or install this CLI globally for development.

```sh
node packages/okf-wiki/bin/okf-wiki.js init /explicit/disposable/vault --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault init --json
WIKI_VAULT=/explicit/disposable/vault node packages/okf-wiki/bin/okf-wiki.js init --json
```

Implemented commands are `init`, `type list`, `type add`, `index`, `index --check`,
`new`, `update` (including no-effect dry-run), `show` (including section selection), and `lint` (including relative links and whole-vault generated-index freshness). The init directory argument is an explicit vault selection. `--vault` takes precedence over `WIKI_VAULT`; an init directory also
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
Registry validation, exclusive scaffolding, and topic creation are implemented.
Source capture and search belong to later slices.

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

## Registry and topic validation

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
body text, never executed or interpolated. Placeholder-looking syntax, fenced code
examples, and Markdown thematic breaks remain literal text. Complete leading
frontmatter blocks, including language-tagged blocks, are refused because templates
supply bodies only. Template engine configuration is not an accepted registry field.
Required headings must appear in the template.
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
`lint`; successful lint reports
`checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", "generated-index"]`
for whole-vault lint. Selected-path lint omits `generated-index`.

Lint checks canonical scope/folder/slug placement, exact type scope restrictions,
registered headings, decision Consequences hierarchy, and duplicate scoped titles
after trimming, NFC normalization, and Unicode default full case folding. Folding uses the pinned,
dependency-free MIT package `unicode-case-folding` (1.1.2), whose generated table
comes from the Unicode Character Database
[CaseFolding.txt](https://www.unicode.org/Public/UCD/latest/ucd/CaseFolding.txt);
[source and license](https://github.com/avivkeller/unicode-case-folding).
Folding affects comparison keys only, not authored titles or accents. Markdown
structure comes from a CommonMark AST; code examples, HTML source blocks, and blockquotes do not satisfy headings
or count as repeated Status:/Type: metadata. Templates use the same heading check.
Lifecycle references require deprecated status and an existing canonical topic.

Inline and reference-style links and images resolve relative to the containing
document. Contained parent links are allowed; canonical CLI and metadata paths
never allow dot segments or encoded unsafe components. Targets must be existing topics,
generated indexes, or retained assets. HTTP/HTTPS and mailto destinations receive
syntax checks only, never network requests. Fragments are preserved and do not
receive heading or block checks. Wikilinks, root-prefixed links, unsafe schemes,
escapes, and symlinked targets or ancestors fail with actionable diagnostics.
Source `original` and `extracted` metadata use canonical retained asset paths;
`resource` is a locator, not a canonical-path field. Custom strings are not
guessed to be paths. Code, quoted source, and escaped literal examples are ignored.

**Current boundary:** generated-index freshness runs only for whole-vault lint,
after registry and authored concepts pass validation. A successful result is not
yet full-product lint. A path selection validates the
entire registry and checks duplicate titles throughout the selected scope(s),
without reporting unrelated notes' other validation errors. Whole-vault lint
applies registry edits to all existing notes. Lint never rewrites files.

## Generated navigation

```sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault index --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault index --check --json
```

`index` validates the current registry and authored concepts once, then overwrites
generated `index.md` files at the vault root and existing maintained content
directories. It excludes operational and capture-asset directories. Rows use
relative links, escaped text, one-line descriptions, and recursive concept counts.
Ordering uses type names and canonical paths, not locale or title order. Only the
root has version frontmatter. No timestamps or mtime caches enter generated output.

Missing planned index targets do not block generation through authored links;
missing authored notes or assets still fail validation. Invalid concepts prevent
publication instead of disappearing from navigation. Unsafe, symlinked, or
non-file destinations fail before publication starts. This does not protect
against hostile filesystem swaps or promise a multi-file transaction. General
cooperating mutations use the vault-local lock described below.

`index --check` and whole-vault `lint` compare actual generated bytes with current
metadata. Missing and edited indexes report `index.missing` and `index.stale`,
with path, message, and regeneration instructions. Both checks are read-only.
Regeneration changes only generated indexes, not authored notes, `log.md`, or Git
state; it creates no commit or operation-log entry.

## Current note reads

```sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault show personal/notes/topic.md --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault show personal/notes/topic.md --section "Next steps" --json
```

Full show returns the current UTF-8 Markdown, including frontmatter, BOM if
present, original line endings, whitespace, and any missing final newline.
JSON returns `{ok:true,path,markdown,digest}`; the digest is
`sha256:<64 lowercase hex digits>` over the captured whole-file bytes.
Human mode writes only the requested Markdown, without an added newline;
use JSON to obtain the path and digest.

`--section` matches exact, case-sensitive rendered heading text, including
formatting contents, decoded entities, inline code, link labels, and image alt
text. Document-level CommonMark ATX and setext headings define sections;
fenced/indented code and headings inside quotes or lists do not. A section
includes its original heading and all source content through, but not including,
the next equal-or-higher heading. This includes nested headings and intervening
blank lines. JSON adds `section` with the requested heading text and keeps
the digest of the entire note, not the selected text.

Missing notes or sections exit 4 (`not_found`); duplicate matching headings
exit 2 (`usage`). Unsafe/noncanonical paths, symlinks, and non-file targets
also exit 2. Invalid UTF-8 exits 6 (`damaged`), never a replacement-character
success. Section selection requires safe mapping frontmatter and reports damaged
data if it cannot parse that boundary. Full show does not lint or reconstruct
the document, so it can also display authored Markdown that needs repair.

Show reads the requested regular Markdown file once by its literal canonical
vault-relative path, outside operational and capture directories. It does not
load registry records, inventory the vault, validate unrelated notes, check
navigation freshness, write files/logs, or start search/models. A frontmatter or
whitespace change anywhere in the note changes the digest. File size and mtime
are not freshness assertions. Containment uses the same trusted-local-filesystem
boundary as the other commands, not protection against hostile concurrent swaps.

## Verification

From the repository root:

```sh
OKF_TEST_PATTERN="okf:01|okf:02" heavy -- bun run test:okf
OKF_TEST_PATTERN="okf:06" heavy -- bun run test:okf
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


## Exclusive topic creation and cooperative mutations (#21)

The new command requires a registered type, exactly one explicit scope, title, and description:

~~~sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault new procedure --project wiki --title "Run safely" --description "Use safe steps" --tags local --tags cli --status draft --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault new note --personal --title "Local knowledge" --description "A local topic" --slug local-knowledge --body-file /explicit/body.md --json
~~~

Without --body-file, creation uses the registry's inert body template. A supplied
file must be UTF-8 body text only, without a leading frontmatter block. Neither
source executes or interpolates placeholders. Frontmatter uses quoted JSON-compatible
YAML strings, including a UTC created timestamp. Optional tags repeat --tags;
status must be draft, stable, or deprecated. No status implies stable.
The command does not invent custom required fields or source provenance. A type
whose requirements cannot be supplied through this interface is refused; source
capture is a separate later command.

Automatic slugs use NFKD decomposition, remove combining marks, lowercase ASCII,
and replace runs of non-ASCII-word characters with hyphens. Empty or reserved
results require --slug. Explicit slugs use the profile's safe-name contract.
A collision never adds a numeric suffix. Titles compare using trimmed, NFC-normalized
Unicode full case folding within a scope, across all registered type folders.
Separate scopes may reuse titles and slugs. Comparison never rewrites authored text.

The shared inventory validates the complete proposed document and current concepts
before publication. Only its exact new path and expected generated indexes may be
missing link targets. Self-links work; unrelated missing notes or assets do not.
Unrelated invalid concepts block creation rather than disappearing from navigation.
The command plans new scope/type-directory indexes before creating directories.
Publication links a complete same-filesystem temporary file exclusively into place;
an existing destination remains intact, including a destination created by an
external writer at publication time.

The new, type add, and mutating index commands acquire .wiki/locks/mutation.lock before
reading mutation state and retain it through publication, navigation, and log
changes. Acquisition is exclusive and fails promptly with exit 3 when busy.
There is no polling, PID-based stealing, or age-based reclamation. The record holds
an ownership token, PID, hostname, and UTC acquisition time for diagnostics.
Release checks both file identity and the token; it does not delete a replacement
lock. Read-only commands do not acquire or modify the lock.

### Explicit stale-lock recovery

1. Stop new cooperating CLI mutations for this vault and keep them stopped during inspection and recovery.
2. Inspect .wiki/locks/mutation.lock, including its token, PID, hostname, and time.
3. On the recorded host, inspect the actual process and command, including whether it still owns active mutation work. A PID alone can be reused.
4. Verify that no cooperating owner remains active. If ownership is uncertain, retain the lock and investigate; age is not proof.
5. Only after that verification, explicitly remove the inspected lock file. Do not remove a newly replaced instance.
6. Inspect the published topic, navigation, and log. Run index and whole-vault lint to repair/check derived navigation. Inspect any missing historical log entry manually; do not invent its time.

The lock coordinates cooperating CLI writers on one local host only. It does not
protect against Obsidian, Git, external editors, or hostile filesystem swaps.
Separate note/index/log writes are not a multi-file transaction. Normal completion
returns path, title, description, and the complete sha256: digest, with current
indexes and exactly one **created** log line. A later index/log failure leaves the
note intact and returns ok: false, written: true, its path and digest, and repair
instructions, never a success result. A failed temporary-name cleanup after exclusive
publication also reports the published path/digest and retained temporaryPath; do not
retry the content write. Final output waits for lock cleanup. A release failure
returns one error object with cleanup details and the retained lock path. Completed
actions include outcome: completed and their published paths and digest (or per-index
digests). A primary action failure keeps its error and publication metadata when
release also fails. Existing concepts must decode as strict UTF-8 before validation;
malformed bytes produce a document.utf8 diagnostic and block navigation/publication.
Rejected validation, busy, and collision
requests publish no topic or success log. Mutations do not stage or commit Git,
load models, start qmd, or change global configuration.


## Expected-digest topic updates (#22)

~~~sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault show personal/notes/topic.md --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault update personal/notes/topic.md --expect sha256:<64-lowercase-hex-digits> --file /explicit/complete-candidate.md --dry-run --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault update personal/notes/topic.md --expect sha256:<64-lowercase-hex-digits> --file /explicit/complete-candidate.md --json
~~~

Replace the digest placeholder with the full digest returned by show. The file is
the complete candidate Markdown, including frontmatter, not a patch or body-only
input. The CLI reads a regular UTF-8 file once before acquiring the mutation lock.
It refuses directories, symlinks, FIFOs, and invalid UTF-8 without a blocking FIFO
open. It retains the candidate's exact bytes, including BOM, CRLF, whitespace, and
missing final newline; it never reconstructs the document from parsed metadata.
Update flags are command-local. Renaming and moving are not update operations.
Generated indexes, logs, operational files, and capture assets are not topic targets.

Validation inventories the whole prospective vault with exactly one identity for
the replacement target. Old target diagnostics do not survive replacement, but
registry errors, unrelated invalid notes, incoming references, scoped normalized
title uniqueness, and type/path agreement still apply. Invalid concepts prevent
misleading partial navigation. The target must already exist as a regular,
contained topic, without symlinked ancestors.

Dry-run compares the observed whole-file base and validates the candidate. It
returns outcome: dry-run, candidateDigest, digest (the candidate digest), summary
byte and changed-line counts, and a diff with one-based startLine and removed/added
line arrays after common edge lines are omitted. Diff text is a review aid, not an
applyable patch; only the supplied file bytes are published. Dry-run does not acquire
or modify locks, create temporary files, update navigation/log/search, or otherwise
write the vault. It can run while a cooperating mutation lock is held; it is not a
reservation for later apply.

Apply uses the same non-stealing vault mutation lock as new, type add, and index.
It validates under that lock and creates the temporary file with mode 0600
(the process umask can restrict this further) before writing candidate bytes.
It copies the actual target's read/write/execute permission bits to that file,
not the candidate's mode or default umask permissions. It then re-reads and hashes
the actual full target bytes immediately before atomic rename. This preserves
POSIX access bits; ACLs, xattrs and ownership preservation are not established. A stale
base exits 3 with path, expected, and current digests. Re-read and reconsider the
candidate after a conflict. Never automatically retry an old candidate with a new
digest. Missing targets exit 4; unsafe targets or invalid candidates exit 2;
duplicate scoped titles and busy cooperating writers exit 3. No rejected write
reports written or appends a successful update log entry.

Successful apply returns outcome: updated, written: true, path, digest,
candidateDigest, summary/diff, navigation: updated, and log: appended. It writes
current generated navigation and one **updated** log entry. A same-byte apply
returns outcome: unchanged with navigation/log: unchanged and no written field.
It performs no content, navigation, or log write. Both successful no-op and dry-run
exit 0. Human output includes identity, candidate digest, summary/diff, and effect
status; JSON has the same named information.

**Exclusive-edit contract:** the owner avoids simultaneous Obsidian or external
edits to the target during apply. Atomic rename prevents partial contents, but it
is not compare-and-swap against noncooperating editors. An external writer can
still race between the final read and rename. If exclusive editing cannot be met,
stop/report or use dry-run. An authorized factual handoff may apply directly;
there is no mandatory proposal-only workflow, authenticated approval/evidence
record, automatic Git action, or automatic publisher.

A post-publication navigation/log failure retains the new note and returns
ok: false, written: true, paths, and its resulting digest with repair guidance.
Run index to repair derived navigation, then inspect log.md before manually adding
any missing historical entry. Do not invent its time or retry the content write.
Final output waits for lock release. Release failures retain cleanup details and
any already-written metadata; completed publication also names outcome: completed.
A failed temporary-file cleanup before publication reports temporaryCleanup with
the retained path and keeps the primary error (including stale conflict digests).
Inspect that temporary file before explicit cleanup. Separate file writes are not
a multi-file transaction and no rollback overwrites external changes.
