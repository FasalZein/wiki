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
`new`, `capture` (local UTF-8 documents, PDFs, and explicit HTTP/HTTPS resources), `update` (including no-effect dry-run), `show` (including section selection), and `lint` (including relative links and whole-vault generated-index freshness). The init directory argument is an explicit vault selection. `--vault` takes precedence over `WIKI_VAULT`; an init directory also
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
Local document and web capture are implemented below; search belongs to later slices.

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
capture uses the separate capture command below.

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


## Explicit UTF-8 document capture (#28)

~~~sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault capture /explicit/document.md --project wiki --title "Selected document" --description "An external observation" --json
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault capture /explicit/document.txt --personal --title "Other observation" --description "A separate capture" --slug other-observation
~~~

Capture requires one explicit scope, title, and description. Optional slugs use the
same deterministic derivation and safe-name rules as new. Existing note paths,
asset directories, and normalized scoped titles conflict without overwrite,
automatic deduplication, or suffixes. Distinct explicit captures may retain
identical bytes. There is no default source scope or automatic registry repair.
The registered source type controls the folder, scope restrictions, frontmatter
schema, and authored headings. A missing or invalid registration must be repaired
explicitly before capture. Unrelated invalid topics also block publication.

This command supports local .txt, .text, .md, and .markdown files,
case-insensitively, plus .pdf through the external pdftotext program and explicit
HTTP/HTTPS resources as described below. For local text documents it opens
input read-only and nonblocking where supported, validates the opened descriptor
as a regular file, reads it once, and decodes strict UTF-8. An unwritten POSIX FIFO
is refused without waiting for a writer. Input symlinks may select a regular
external file; managed vault destinations must not have symlinked ancestors.
Malformed UTF-8 and unsupported extensions exit 5 before publication or a success
log entry. Invalid requests/schema exit 2, and existing destinations or busy
cooperating writers exit 3. The source input is not modified.

Original and full extracted UTF-8 bytes are retained separately under
<scope>/assets/<slug>/original.<extension> and extracted.txt. Text documents preserve BOM,
Unicode, original newline forms, and a missing final newline without normalization.
PDF originals retain exact binary bytes; extracted assets retain complete UTF-8
pdftotext output, without trimming or an added rendering newline.
The source note uses the registered folder, initially references. Its full
extracted text is fenced with a delimiter that no input run can close; captured
headings, links, metadata, and instructions remain untrusted literal content.
Only the wrapper heading and document-relative asset links are authored Markdown.
An added final newline for the literal rendering does not change retained assets.
No automatic resource-size limit is imposed: input, extraction, rendered Markdown,
and parsing structures reside in memory. There is no model summarization, request
claim, attestation, recursive import, or global asset cache.

Extraction finishes before taking the mutation lock. Under the lock, the command
reloads the registry and validates the complete prospective vault, including exact
planned asset paths and bytes. It does not temporarily publish assets to make
validation pass. Existing creation and replacement validation remain unchanged.
It reserves the capture asset directory and exclusively publishes complete files
from same-filesystem temporary files, then generates navigation and one captured
log entry. Normal completion passes whole-vault lint and index --check.

Success JSON includes path, title, description, the full source-note digest,
resource (the selected absolute file URL or requested web URL), retrieved, original, original_sha256,
extracted, extracted_sha256, extractor, extractor_version, and media_type. The
UTF-8 extractor is okf-wiki:utf8 version 1. It also returns written: true, paths,
per-path digests, and an assets list with canonical paths/digests, never file
buffers. Digests use the sha256: prefix. Human output names the source path and
prints the same scalar provenance and digests. Retained reads never refetch input.

Separate files are not one transaction. After any authoritative publication,
a later failure returns ok: false with written: true, only this operation's
actually published asset/note paths and per-path digests, and explicit inspection
and repair steps. It retains published assets even if no source note was published. An exclusively
reserved capture directory is reported as retainedDirectory, even when creating
the first file fails; inspect it before explicit cleanup or a new attempt. An empty
reserved directory does not produce written: true or invented file digests.
It does not claim an external collision file as its own or roll back later edits.
Unpublished temporary-cleanup failures retain the primary error and report
temporaryCleanup. Lock cleanup is reported separately as cleanup. Completed
publication followed by failed lock release reports outcome: completed rather
than emitting an earlier success. Both human and JSON output wait for required
lock cleanup. Inspect retained temporary files before explicit cleanup; run index
to repair navigation when a source note exists, and inspect log.md before manually
adding any missing historical entry. Never invent a log timestamp or retry a
partially published capture automatically.

Real-process text capture proof lives in test/capture-cli.test.ts (okf:14); preparation,
FIFO, byte-fidelity, and planned-asset checks live in test/capture-text.test.ts.

## PDF capture (#29)

~~~sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault capture /explicit/document.pdf --personal --title "Selected PDF" --description "An external observation" --json
~~~

PDF capture uses the same scope, registry, literal rendering, asset validation,
exclusive publication, and partial-result contracts as text capture. It reads a
regular input file once before extraction. Both retention and pdftotext receive
that captured buffer, not a reopened mutable pathname. The invocation is exactly
`pdftotext -enc UTF-8 -eol unix -nopgbrk - -`, with PDF bytes on stdin and extracted
bytes on stdout. Metadata records `media_type: application/pdf`, the actual
version reported by `pdftotext -v`, retrieval time, and independent asset digests.
A retained source and its assets remain usable after the selected input is removed.

The program must already be on PATH. Missing or unstartable pdftotext, or an
unusable version response, returns exit 7 (`unavailable`) with an actionable
error. Capture never installs a program or uses another parser or OCR fallback.
A corrupt PDF, nonzero extractor exit, or invalid UTF-8 output returns exit 5
(`unsupported`), without invented content or retained publication. An empty or
whitespace-only extracted layer retains its exact output and original PDF and
adds `limitations: ["PDF has no extracted text layer; no OCR performed"]` to the
source metadata and command result. Human output also prints this limitation.
No successful PDF capture implies OCR or confirms the truth of extracted content.

SIGINT and SIGTERM during preparation abort the version probe or extractor by
sending SIGTERM to the direct child. The command waits for child/stdio close
before returning exit 7 with a cancellation error, without taking the mutation
lock, publishing assets/a source note, or appending a success log. The extractor
is not detached. There is no timeout, retry, forced-kill escalation, process-tree
supervisor, or automatic resource-size limit. A replacement program that ignores
SIGTERM or leaves descendants holding stdio can keep cleanup waiting; use the
real cooperative pdftotext executable. Synchronous input reads and rendering do
not process signals until Node resumes its event loop. Signals during later
synchronous publication are not a rollback mechanism; inspect any retained files
using the partial-publication guidance above. Input, output, and rendered source
remain in memory, so callers must select resources appropriate for available memory.

Synthetic fixtures and real CLI/extractor checks live in test/capture-pdf.test.ts
(okf:15). Expected text comes from authored PDF content, not recorded tool output.
Tool failures and in-flight process boundaries use disposable program doubles.
For a bounded affected run equivalent to the okf:15 wrapper selection:

~~~sh
heavy --slots 2 -- node --test --test-concurrency=1 --test-name-pattern "okf:15" packages/okf-wiki/test/capture-pdf.test.ts
heavy -- bun run typecheck:okf
~~~

## Explicit web capture (#30)

~~~sh
node packages/okf-wiki/bin/okf-wiki.js --vault /explicit/disposable/vault capture 'http://127.0.0.1:8080/selected-resource' --personal --title "Selected resource" --description "An external observation" --json
~~~

Select exactly one HTTP/HTTPS resource. Supported response media types are
text/plain, text/html, application/xhtml+xml, and application/pdf. The command
fetches only that resource and its HTTP/HTTPS redirects. It never crawls links,
fetches images, stylesheets, scripts, or iframes, executes page scripts, discovers
credentials, or adds session cookies or ambient authorization headers. URL
credentials and non-HTTP(S) URLs or redirect destinations are refused. Redirects
use the Fetch Standard limit of 20, not a retry loop. No authentication/session
feature, hosted inference, model summary, installer, or fallback parser is added.

The original asset retains the exact response-body Buffer supplied by Node Fetch;
HTTP transfer/content coding is handled by Fetch, not retained as wire framing.
The extracted asset retains the complete UTF-8 extraction, with its own digest.
Original extensions are .txt, .html, .xhtml, or .pdf according to response media
type, not the URL suffix. Metadata records resource (the normalized requested
URL), final_resource when redirected to a different URL, retrieval time at the
final response headers, media_type, both digests, and actual extractor/version.
Reads use only these retained files, even after the server is unavailable.
PDF responses feed that same captured Buffer to the existing pdftotext extractor;
there is no second request or reopening of the URL as a file.

Plain text uses strict TextDecoder decoding and records text-decoder with the
running Node version. For text and HTML, a BOM takes precedence over the transport
charset. HTML then uses a supported transport charset, otherwise a meta charset
whose entire declaration ends within the first 1024 bytes, otherwise UTF-8.
Commented declarations do not count. Unsupported HTML transport labels fall back
to meta/UTF-8; unsupported meta labels and unsupported plain-text transport labels
fail. Invalid encoded bytes fail rather than inserting replacement characters.
This preserves the existing extractor's charset rules, not a browser DOM or XML
encoding implementation. Plain-text BOM decoding follows TextDecoder behavior;
local UTF-8 document capture keeps its existing byte-preserving BOM behavior.

HTML/XHTML extraction runs exactly
`pandoc -f html-smart -t json --sandbox`, with decoded UTF-8 HTML on stdin.
Pandoc must already be on PATH, and its real --version is recorded. The JSON AST
renderer preserves supported title, paragraph, heading, inline, code, list,
quote, table caption/cell, nested table, and figure text. It does not preserve
visual layout, styling, link targets, table geometry, or non-title metadata.
Every HTML source records the static-text/script/subresource/layout/metadata
limitation. Known RawBlock/RawInline regions add explicit limitations metadata;
they are never executed. Unknown node types or malformed text-bearing structures
fail instead of silently dropping regions or inventing content. There is no
browser rendering, JavaScript execution, OCR, or linked-resource extraction.

HTTP/network/body failures return unavailable (exit 7). Missing/unstartable tools
or unusable version responses also return exit 7. Unsupported media, URL schemes,
charsets, undecodable text, failed extraction, invalid JSON, and unknown/malformed
AST text forms return unsupported (exit 5). All preparation failures occur before
the mutation lock, asset/source publication, or a success log entry. Successful
preparation uses the same planned-assets, current-registry validation, exclusive
publisher, and truthful partial-publication contract documented above.

SIGINT/SIGTERM abort in-flight request/body reads and send SIGTERM to a direct
extractor/version child. Final output waits for direct-child and stdio closure.
The cooperative-child and synchronous-publication limits from PDF capture apply:
no forced escalation, descendant supervisor, automatic cleanup/rollback, or new
application timeout. Node/runtime protocol limits still apply. There is no
automatic resource-size limit. Response bodies, decoded text, tool output,
rendered source, and parsing structures remain in memory; callers must select
resources appropriate for available memory.

Real CLI/local HTTP cases are test/capture-web.test.ts; focused malformed/unknown
AST checks are test/html.test.ts, all named okf:16. Normal extraction uses real
Pandoc and pdftotext on synthetic content. Failure and signal interleavings use
faithful disposable process doubles; cancellation is coordinated at observed
request/body/tool events, not polling delays. The bounded command below selects
all named web cases without the directory-wide wrapper's default fanout:

~~~sh
heavy --slots 2 -- node --test --test-concurrency=1 --test-name-pattern "okf:16" packages/okf-wiki/test/capture-web.test.ts packages/okf-wiki/test/html.test.ts
heavy -- bun run typecheck:okf
~~~
