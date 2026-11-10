# Wiki rearchitecture

Status: Owner-approved structure-first build direction, reconciled 2026-11-06. This file is the authoritative build specification. Implementation and runtime verification remain outstanding.

This specification supersedes the 2026-10-05 evidence-first implementation plan previously stored here. Existing evidence-first code in `packages/wiki-core` and `packages/wiki-cli`, legacy code, and historical evidence records remain untouched (both packages and the legacy code were later removed: #38, #41). The new foundation is CLI + schema registry + skill + an inactive repository-owned dedicated wiki-agent example. GitHub ticket publication and closure of #9-#14 require owner approval of exact text; this repository update does not authorize those writes.

## Problem Statement

The wiki mixes reusable knowledge with delivery records. Its structure depends too much on instructions that tools do not enforce. Agents read too much context, create inconsistent documents, and can retrieve obsolete text. The previous rearchitecture also grew an evidence and background-runtime design that the owner subsequently replaced.

The owner needs topic-based Markdown knowledge that remains useful in Obsidian and is cheap for agents to navigate. GitHub must own delivery state. Code repositories must own specifications. Pi must retain transcripts.

The foundation must work without choosing a permanent vault, migrating historical notes, installing global tools, or selecting a maintenance model.

## Solution

Build a fresh Node CLI beside the existing packages. Use an Open Knowledge Format (OKF) v0.2-derived local profile, a vault-owned schema registry, canonical scoped topic paths, generated indexes, and deterministic validation. Use qmd as the only indexed search engine.

A repository-owned skill teaches the working agent when and how to hand distilled findings to a dedicated wiki agent. The wiki agent searches, reads related topics, and applies authorized factual updates directly or returns a proposal when the handoff lacks write authority or changes owner decisions/intent. No Pi extension, event hook, background service, transcript harvester, or automatic publisher is part of this release.

Markdown remains authoritative. Search storage is disposable. Current file digests support stale-base refusal and search identity, not attestation or claims of truth. Captured sources retain original bytes and full extracted text locally.

## User Stories

1. As an owner, I edit topic pages directly in Obsidian without adopting a new editor or database.
2. As an owner, I keep knowledge separate from tasks, delivery status, and code-repository specifications.
3. As a working agent, I find a scoped topic without reading a whole-vault roster.
4. As a working agent, I read one relevant section and receive the digest of its complete source note.
5. As a working agent, I hand over reusable findings explicitly instead of copying a transcript.
6. As a wiki agent, I search existing topics before I propose a new page.
7. As a wiki agent, I use registry rules instead of inventing note types or folders.
8. As an owner, I add a type by reviewing data, not by changing CLI code.
9. As an owner, I see actionable lint errors after a direct Markdown edit.
10. As an owner, I regenerate indexes deterministically and detect stale generated output.
11. As an agent, I create a valid note without overwriting an existing topic.
12. As an agent, I cannot apply a candidate against a detected stale note revision.
13. As an owner, I retain concurrent cooperating CLI updates without last-writer-wins loss.
14. As an owner, I know that CLI locks do not coordinate Obsidian or other external writers.
15. As an owner, I review proposals that change decisions, intent, or personal meaning.
16. As an agent, I search with typed lexical and semantic queries without default expansion or reranking.
17. As an agent, I use an explicit deep search when the fast results do not answer.
18. As an agent, I find literal paths and dotted filenames that semantic retrieval can miss.
19. As an agent, I never receive a deleted note as a valid search result.
20. As an agent, I receive text from a currently read note, not an old indexed excerpt labelled as current.
21. As an owner, I distinguish incomplete embeddings from current note text and from external-source accuracy.
22. As a researcher, I capture an explicitly requested web resource without crawling its linked resources.
23. As an owner, I retain original imported text and PDF bytes beside extracted text.
24. As an owner, I receive an explicit failure for unreadable or unsupported material rather than invented contents.
25. As a script author, I use consistent JSON results and exit codes without starting Pi.
26. As an owner, I test the complete foundation in disposable vaults without choosing a rollout location.
27. As an owner, I preserve the installed legacy CLI and historical vault until a separate cutover approval.
28. As an owner, I select any future maintenance model separately from implementation-helper routing and data-sharing consent.

## Domain Glossary

These are domain meanings, not storage or implementation definitions.

| Term | Meaning |
| --- | --- |
| Wiki | The maintained collection of reusable knowledge. |
| Vault | One independently configured collection of wiki material. |
| Scope | The project or personal area to which a topic belongs. |
| Topic page / note | A maintained explanation, decision, procedure, finding, reference, or personal thought about one topic. |
| Type | The declared category and content rules of a topic page. |
| Registry | The reviewed set of types accepted by a vault. |
| Canonical topic path | The unique address of a topic in its scope. A rename changes that address. |
| Lifecycle | Whether knowledge is draft, stable, or deprecated. It is not delivery progress. |
| Finding | Distilled reusable knowledge from work or investigation, with its source references. |
| Source capture | A retained observation of external material, not proof that its contents are correct. |
| Candidate | Proposed content that has not yet been applied to a maintained topic. |
| Handoff | An explicit transfer of distilled findings and permitted actions from a working agent to the wiki agent. |
| Working agent | The agent performing the original task. |
| Wiki agent | The dedicated agent that organizes and maintains wiki knowledge within the handoff authority. |
| Source correctness | Whether a claim agrees with its external subject. This foundation does not certify it. |

## Decision Status and Precedence

`P` means prior approved direction. `L` means latest confirmed owner direction, including direct authorized updates. `A` means a routine, reversible engineering choice specified for this build. `DEFERRED` means excluded from this build, not secretly required by it. No product decision below is OPEN. Exact GitHub ticket and supersession-comment text still needs owner approval before publication.

| ID | Status | Decision |
| --- | --- | --- |
| D01 | P + L | Deliver CLI + skill + inactive repository-owned dedicated wiki-agent example. No Pi extension, automatic hooks, service, or background maintenance initially. |
| D02 | P | Markdown is authoritative; GitHub owns delivery state; specs stay in code repositories; transcripts stay in Pi. |
| D03 | P + A | Use scoped topic paths, not numeric IDs or atomic-fact records. Ship project and personal scope support without selecting real import locations. |
| D04 | P | Types come from a vault-owned registry, one JSON file per type. Registry changes require whole-vault lint to pass in the same reviewed change. |
| D05 | P + A | Enforce the flat OKF-derived local profile and lifecycle below. Initial templates are replaceable defaults, not a compile-time seven-type universe. |
| D06 | A | Generate document-relative Markdown links. Reject wikilinks and leading-slash internal links in this initial profile. Do not claim untested Obsidian root-link behavior. |
| D07 | P + A | Generate deterministic directory indexes; retain a simple human-readable CLI change log. Neither is an evidence ledger. |
| D08 | P + A | Validate before CLI content writes. Expose lint, index check, small read results, and stable JSON/exit contracts. |
| D09 | L + A | Require exact expected full-file digest for updates; serialize cooperating CLI mutations. Reject detected stale bases before content effects. No external-editor compare-and-swap guarantee. |
| D10 | P + A | Use the qmd SDK with a vault-local index. Do not build a second FTS5, vector, ranking, or search stack. |
| D11 | P | Fast mode is one qmd typed lex/vec query without expansion or reranking, plus literal matching for path-like tokens. Deep mode explicitly enables qmd expansion and reranking. |
| D12 | P + A | Check actual content, additions, deletions, and renames before search. Distinguish text coverage, embedding coverage, and source correctness. |
| D13 | P + A | Build explicit local text, PDF, and web capture. Retain original bytes and complete extracted text. Do not restore evidence/check/attestation operations. |
| D14 | L + P + A | Use an explicit distilled handoff. Apply authorized factual updates directly under D09; do not default authorized work to proposals-only. Decisions, intent, policy, and personal meaning still need owner approval. |
| D15 | L + P | Store skill and agent templates in the repository. No global install, provider selection, credential access, or vault-content egress is authorized by this build. |
| D16 | P + A | Run from Node sources in a new package, reuse safe generic code and test patterns, and leave evidence packages and legacy runtime behavior intact. |
| D17 | P + L | Verify real-process behavior in disposable fixtures, with isolated search state and no live archive or installed binary changes. |

## Implementation Decisions

### D01-D02: release boundary and authority

The new CLI must start independently of Pi. The skill and inactive agent example are declarative repository assets, not runtime integrations. The working agent invokes the wiki agent explicitly using the available host workflow. There is no automatic call on completion, compaction, shutdown, or tool execution.

The CLI performs deterministic mechanical operations. It does not summarize, classify, choose models, call hosted inference, fetch code repositories, or decide whether a decision has owner approval. A schema-valid note is not thereby true, reviewed, current against code, or owner-approved.

The dedicated agent uses search, small reads, and CLI validation to maintain structure. Its authority comes from the explicit task, not from a frontmatter claim. Prompt rules are workflow controls, not filesystem security or authenticated approval.

### D03: scope, identity, and layout contract

The logical layout is:

```text
<vault>/
  .wiki/
    config.json
    types/<type>.json
    qmd.sqlite                 derived; excluded from Git with related SQLite sidecars
    tmp/                       disposable
    locks/                     cooperative local locks; not authority
  index.md                     generated root, with okf_version: "0.2"
  log.md                       CLI operation log
  projects/<project>/
    index.md                   generated
    <registered-folder>/<slug>.md
    assets/<capture-slug>/original.<extension>
    assets/<capture-slug>/extracted.txt
  personal/
    index.md                   generated
    <registered-folder>/<slug>.md
    assets/<capture-slug>/...
```

This is a file-format contract, not a required source-module decomposition. The versioned configuration identifies profile `wiki-okf` and profile version 1. Its optional search model settings name explicit local embedding, expansion, and reranker files; initialization leaves them unset. No provider, credential, repository-evidence, or maintenance-runner settings are required. Reject unsupported config versions instead of guessing a migration. There is no global default vault. Commands require `--vault <dir>` or `WIKI_VAULT`; an explicit flag wins. They never fall back to the historical vault.

Project names, type names, registered folder names, and explicit slugs are lowercase ASCII words separated by hyphens: `[a-z0-9]+(?:-[a-z0-9]+)*`. Reserved names include generated files, operational directories, `assets`, and scope roots. A title is free text. If no slug is supplied, derive it deterministically from the title; if no valid slug remains, request `--slug`. A collision is an error, not a request to append a number.

Each note lives exactly at its scope, registered folder, and slug. Its identity is that path without `.md`; returned paths include `.md` and use `/` separators. There is no frontmatter `id`. The same slug or title may occur in different scopes. Duplicate titles within one scope are rejected after trim and case-fold normalization; this is a structural duplicate check, not semantic deduplication.

Initial personal scope support uses one `personal/` area. This is fixture and layout support, not a decision about the owners historical personal-note placement.

Canonical-path arguments must not be absolute, contain backslashes, NUL, empty segments, `.` or `..`, or escape the selected vault. Read and write destinations must stay inside the canonical vault root after existing ancestor resolution. Symlinked note trees, target files, or write ancestors are refused. This is protection against accidental escape in a trusted local vault, not a hostile-filesystem sandbox. No external program receives authored shell fragments.

Ignore operational directories, Git, Obsidian configuration, dependency directories, and capture assets when scanning concepts. Generated indexes and the operation log are not concepts and do not enter topic search. Unexpected Markdown inside maintained scope trees is a lint diagnostic, not silent exclusion.

### D04: registry contract

One registry JSON record declares `name`, `folder`, `frontmatterSchema`, `requiredHeadings`, `template`, and optional `scopes`. The file stem equals `name`. `scopes`, when present, contains exact scope keys such as `projects/wiki` or `personal`. Absence allows all supported scopes. The folder is unique across registered types in a scope.

`frontmatterSchema` uses JSON Schema draft 2020-12. A standard validator must enforce it. The old field-definition DSL is not JSON Schema and must not be labelled as such. Common profile requirements remain mandatory; a type can narrow them and add flat properties but cannot remove them. Remote schema references, executable templates, and schema-triggered network access are prohibited. Local references within a type schema are sufficient for the first release. Invalid schemas, conflicting folders, unsafe names, invalid scope rules, or missing template requirements are registry errors.

Ship these SEED templates so a fresh disposable vault demonstrates all required knowledge classes:

| Type | Folder | Required body structure |
| --- | --- | --- |
| decision | decisions | MADR minimal: Context and Problem Statement, Considered Options, Decision Outcome, and Consequences; Consequences is level 3 under Decision Outcome. |
| architecture | architecture | No fixed headings. |
| procedure | procedures | A level-2 Steps heading. |
| research | research | Level-2 Findings and Sources headings. |
| reference | reference | No fixed headings. |
| source | references | Captured text and source provenance; generated template includes Extracted Text. |
| note | notes | No fixed headings. |

The set of seven is not a permanent owner taxonomy decision. Adding an eighth type by reviewed data must work without source changes. Specs, tasks, PRDs, slices, handoffs, and session dumps are not seed types. Registry mutation by the wiki agent is not authorized.

`type list` returns type names, folders, requirements, and scope constraints. `type add <name> --folder <folder>` creates a data scaffold exclusively; it never overwrites or silently migrates existing notes. The resulting registry must pass full-vault lint before commit. No automatic Git hook is installed to enforce that obligation in this release.

### D05: local authored Markdown profile

All concepts use UTF-8 Markdown and YAML mapping frontmatter, parsed as safe data only. Do not permit language-tagged executable engines, unsafe YAML tags, or failed-parse cache reuse. A malformed YAML file remains invalid on repeated reads. Read YAML first; do not prefilter note identity or type from raw bytes.

| Field | Requirement |
| --- | --- |
| type | Required registered type, matching the folder and scope. |
| title | Required nonempty single-line string. |
| description | Required nonempty single-line string suitable for an index line. One sentence is authoring guidance, not a sentence-classifier rule. |
| tags | Optional list of lowercase nonempty strings. |
| status | Optional `draft`, `stable`, or `deprecated`; absent means stable. |
| created | Required ISO 8601 date-time with explicit UTC offset. CLI writes a quoted UTC string. |
| stale_after | Optional date-time with explicit offset. It is an author-supplied review reminder, not detected source drift. |
| superseded_by | Optional canonical topic path with `.md`; allowed only with deprecated status and an existing target. This metadata value is not a leading-slash Markdown link. |
| resource | Required for source notes; URL or original document locator. |
| retrieved | Required for source capture; date-time with offset. |

Captured-source schemas also allow flat paths, digests, extractor name/version, media type, final resource when redirected, and a list of extraction limitations as specified under D13. A flat list of scalar strings is permitted; nested source/trust/review objects are not part of the profile.

Additional flat properties are allowed only when declared by the registry schema. There is no `updated` field. If Git change time is displayed, label it as the last committed change and show unavailable for untracked material; do not use it as a content-freshness assertion. Use a safe YAML data schema that preserves timestamp strings, or validate the authored offset-bearing date-time syntax before any Date normalization. A bare date or implicit timezone must not become compliant merely because a parser coerces it to a Date. Do not change the bytes read, permit executable engines, or accept Date objects as arbitrary string fields.

A decision proposal is draft. Accepted decisions use stable only after the owner makes that choice. Lint checks lifecycle syntax and references, not the authenticity of that choice.

Body checks ignore fenced code, inline code, and quoted source text when identifying structural duplication or forbidden link syntax. Outside those contexts, reject a standalone metadata-style `Status:` or `Type:` line. Do not reject ordinary prose containing those words. Required headings are actual Markdown headings, not strings inside code examples.

The output is OKF-derived and targets OKF v0.2 producer shapes. Strict local lint is not a promise that the CLI is a permissive general OKF consumer. Do not advertise unknown-type rejection or broken-link rejection as OKF consumer conformance. The root version marker identifies the produced format, not trust certification.

### D06: Markdown links

Generate relative Markdown links from the containing document, including the `.md` target for notes and explicit `index.md` for directory navigation. Relative `..` in a Markdown link is allowed only when its resolved target stays inside the vault. This differs from canonical-path arguments, which never contain `..`.

Validate inline and reference-style Markdown links and image targets using a Markdown parser, not a regex over prose. Ignore code examples and quoted source captures. Allow HTTP/HTTPS and mailto links without network checks. A local link must resolve to an existing note, generated index, or retained asset within the vault. Percent-decoding must not bypass containment. Reject internal leading-slash links, `file:` links, executable schemes, and wikilinks outside examples. Same-document or target fragments are preserved; first release validates the target file, not Obsidian heading/block-fragment semantics.

A move made in Obsidian can change the canonical topic address. Whole-vault lint detects remaining broken references; this build has no rename command or automatic backlink migration. Root-link opening and rename behavior in Obsidian is unverified and is not an acceptance dependency because this profile does not generate root links. Desktop open/rename validation of relative links remains a personal-rollout check.

### D07-D08: init, indexes, lint, and operation log

`init <dir>` creates a new isolated-profile vault, the registry, the root index, an empty log, and ignore rules for rebuildable search files and scratch/locks. It does not run Git, create global configuration, install hooks, load models, or index any historical vault. Repeating init on a compatible profile preserves existing files. A nonempty foreign vault or unsupported config version is refused without conversion. Interrupted initialization reports the exact incomplete state; do not overwrite authored material in a repair attempt.

Generate an `index.md` for the vault root and each existing maintained content directory. Do not create indexes inside assets or operational directories. Concept rows use `* [Title](relative-path.md) - description`; child directories link to their index and give a recursive concept count. Root index frontmatter contains only `okf_version: "0.2"`; non-root indexes have no frontmatter. Sort deterministically by type name and canonical path using locale-independent ordering. Escape Markdown labels and preserve a one-line row. Do not add timestamps or read mtimes to decide whether an index is current.

`index` uses the captured content inventory to regenerate output; it refuses invalid concepts rather than silently omitting them. `index --check` compares expected bytes and exits 1 if anything differs, including a missing generated file. In a successful write command, only affected ancestor indexes and new content directories need rewriting, provided their result equals a full regeneration.

`lint [path]` returns all applicable errors with path, stable rule, message, and fix hint. Full-vault lint checks registry validity, profile fields, folder/scope, required headings, duplicate scoped titles, links, and generated-index freshness. A path-scoped lint still checks the registry, scoped duplicates, and that notes links; full-vault lint is mandatory for registry changes and delivery acceptance. Lint never rewrites content or indexes.

`log.md` uses newest-first `## YYYY-MM-DD` UTC headings and a bold action such as created, updated, captured, or type-added. Add one line on a normally completed content or registry mutation, pointing to the result with a relative Markdown link. Read-only commands, index regeneration, and rejected writes do not add entries. A same-byte update is a no-op and adds no entry. The log is human-readable history, not a transaction journal: a crash after a content write can omit its line. Do not claim complete audit, exactly-once recovery, or source truth from it.

CLI writes validate the prospective note and affected references before publication. A known existing unrelated invalid concept makes a full index rebuild fail; do not silently publish a clean-looking roster. On normal successful writes, lint and index check pass. Partial effects are described below.

### D08-D09: CLI write and error contract

All commands accept `--json`. Successful JSON has `ok: true` and named operation results. Errors have `ok: false` and `error: {code, message}`; lint diagnostics also include rule/path/fix hints. A write that has already changed authoritative bytes reports `written: true`, affected paths, and current digest despite a later failure. Do not print success before known required effects finish.

| Exit | Meaning |
| --- | --- |
| 0 | Completed result, successful no-op, or a successful search with explicit incomplete-coverage warnings. |
| 1 | Lint/index-check violation or unexpected internal failure, distinguished by the error code. |
| 2 | Usage, malformed input, or invalid proposed content. |
| 3 | Existing destination, stale base, or cooperative writer busy/conflict. |
| 4 | Missing requested note, section, or vault. |
| 5 | Unsupported profile, format, or extraction input. |
| 6 | Damaged local retained data/configuration. No attestation meaning. |
| 7 | Unavailable external program, model, network resource, or search dependency without a usable result. |

Create takes a type, exactly one scope selector, title, description, optional slug/tags/status, and either a body file or the registry template. A body file supplies body text only. Do not treat it as executable templating. Validate the full prospective document; create exclusively from a fully written same-filesystem temporary file. An existing path or duplicate scoped title never gets overwritten or silently redirected.

Update takes a canonical note path, `--expect sha256:<64 lowercase hex digits>`, and `--file <candidate-markdown>`. The candidate is the complete proposed Markdown document. Preserve unknown bytes by reading them; do not silently reconstruct a users note from an old parsed object. Validate the candidate; type and canonical path must still agree. Renaming and moving are out of scope.

`update --dry-run` validates and compares the current base, returns a summary/diff and candidate digest, and makes NO vault change, including no indexes/log/search mutations. This supports a review proposal without building an evidence/staging/review-record subsystem.

For an actual update, take a vault-wide cooperative mutation lock, then read current bytes and compare the full digest immediately before replacement. The critical section also protects scoped duplicate checks and CLI-owned index/log updates. Two cooperating updates using the same old digest cannot both replace the note; exactly one can succeed. Reject a missing target, changed base, symlink, invalid candidate, or duplicate title before content effects. Return the conflict path and expected/current digests without applying the candidate.

The lock coordinates CLI writers only. Acquisition fails promptly with a busy result instead of polling indefinitely. Do not reclaim a lock from age or mtime alone. Record a local ownership token and process identity for diagnostics; release only the lock instance owned by this process. A crash-left lock requires an explicit operator inspection/removal procedure that verifies no cooperating owner is active. This is a local single-host contract, not distributed locking.

Atomic rename prevents partial file contents. It does NOT conditionally replace against Obsidian, Git, or arbitrary external writers. There remains a race between the final digest read and replacement by a noncooperating editor. Consequently:

- The owner chose **Apply authorized updates directly**. Supported apply requires an exclusive-edit workflow: the owner avoids editing the same target notes in Obsidian during apply.
- An explicit handoff may authorize factual updates. Use that authority for direct apply after schema/digest checks; do not require a separate proposal for every authorized update. If the exclusive-edit condition cannot be met, stop and report the conflict or offer a dry-run, rather than pretending the race is solved.
- This release enables no unattended publication and makes no zero-loss claim for simultaneous external editing.
- A later automatic publisher needs a separately approved editor-coordination design and real editor tests.

Do not keep the mutation lock while performing network capture, model inference, qmd embedding, or lengthy search. Validate/extract candidate inputs first; reacquire and recheck before content effects. Search has its own cooperative index-writer lock. Separate file writes are not a multi-file transaction. If note publication succeeds but log/index generation fails, report the partial result, leave the published note intact, and name repair steps. `index` repairs derived output; it must not invent historical log timestamps. No blanket retry, rollback over external edits, `git add`, or commit follows a partial result.

### D08: commands and small reads

The examples use logical command name `wiki`; development uses the repository Node entry point, never the installed legacy binary.

| Command | Observable behavior |
| --- | --- |
| init <dir> | Creates or opens only a compatible explicit vault. |
| type list | Lists registry types and rules, without bodies of every note. |
| type add <name> --folder <folder> | Exclusively creates a reviewable registry scaffold. |
| lint [path] | Reports deterministic diagnostics without modifications. |
| index [--check] | Regenerates or checks generated indexes. |
| new <type> (--project <p> or --personal) --title <t> --description <d> [--slug <s>] [--body-file <f>] | Creates a valid topic; returns its path, title, description, and full digest. |
| show <path> [--section <heading>] | Returns the complete current Markdown document, or one selected section, with full-note digest. |
| update <path> --expect <digest> --file <candidate> [--dry-run] | Validates a candidate and refuses a detected stale base. |
| find <question> [--terms <keywords>] [--project <p> or --personal] [--type <t>] [--limit <n>] | Fast qmd typed hybrid plus literal path matching. |
| find --deep <question> [same scope/type/limit filters] | qmd expansion and reranking, explicitly requested. |
| search sync [--embed] | Synchronizes the local text index; --embed additionally fills missing current embeddings synchronously. |
| capture <url-or-file> (--project <p> or --personal) --title <t> --description <d> [--slug <s>] | Captures supported material into a source note, original bytes, and full extracted text. |
| doctor | Reports layout, registry, runtime, extractor, and search readiness without installing or repairing anything. |

One inventory per command captures actual note bytes once for parsing and digest computation. Additional reads are allowed where a concurrency check requires them. Do not introduce a long-lived cache or rescan the vault once per search hit. `show` uses exact canonical path lookup, not fuzzy short IDs. Section selection uses exact rendered heading text and returns the heading and content through the next equal-or-higher heading. Missing or duplicate matching headings are explicit errors. Full show returns the complete Markdown, including frontmatter, without reconstruction. JSON uses a `markdown` field for that UTF-8 document; section mode uses that field for the selected section and identifies the selection. The digest always covers the whole note, including frontmatter and whitespace, not the selected section.

`find --limit` accepts a caller-provided positive integer. When omitted, use and document the pinned dependency’s documented default; do not invent a separate result cap. Results contain canonical path, scope, type, title, description, full current-note digest, and compact current text such as the note description or a matching line. Do not impose a speculative fixed excerpt length or return full bodies by default. Use `show` for larger reads.

### D10-D12: qmd integration, freshness, and retrieval

Use the public qmd SDK, not the globally installed qmd command or global collections. The selected dependency version must be pinned and exercised under the supported Node runtime. The repository-local qmd checkout demonstrates SDK capabilities, but is not itself the product dependency or proof that another installed version behaves identically.

Use a vault-local database and inline configuration limited to maintained scope trees. Exclude generated indexes, logs, assets, operational files, and invalid/unrecognized material from concept retrieval. A separate incomplete-coverage diagnostic must describe skipped invalid or unreadable concepts. Native SDK failures must not fall through to a newly built search engine. qmd lexical retrieval is still the same engine, not a second stack.

Search and indexing never mutate a global qmd database, configuration, or model cache. Existing local model files can be configured explicitly. Accept local file paths, not remote model URIs, in the initial profile. Preflight the needed paths before invoking SDK query/embedding operations so its default model resolver cannot trigger a hidden download. Missing models produce a readiness diagnostic; commands must not silently download them or contact hosted inference. Any later model provisioning is an explicit, separate setup action to an approved location. This does not reopen the owner-approved acceptance of local qmd models.

`search sync` and each `find` compare a complete inventory of current paths and full file digests with successful indexed coverage. The inventory reads contents even when size and mtime match. Call qmd update for additions, edits, removals, or renames. A rename removes the old canonical identity and adds the new one, even if contents are identical. Advance coverage only after successful update and comparison against the indexed content. Deleting the database and manifest must permit a complete rebuild from retained files.

qmd text update and vector embedding are different operations. A successful text update does not mean new or changed content has embeddings. `search sync --embed` explicitly waits for missing current embeddings and reports failures. Ordinary `find` does not hide an expensive whole-vault embed pass behind its fast mode. It synchronizes text and uses available current embeddings, reporting pending embedding coverage. No background embedding child is detached.

Fast mode constructs one typed query with `lex` from `--terms` and `vec` from the question, with reranking false and no expansion. Without `--terms`, reuse the literal question as the lexical query; do not call a model to invent terms. Deep mode sends the question through qmd expansion and reranking. The skill advises deep mode after an inadequate fast result; it is never triggered silently.

For tokens containing `/` or a dotted filename form, run literal substring matching against canonical paths and captured current note text. Treat the token as text, not regex, shell, or FTS syntax. Literal matches precede qmd candidates. Deduplicate by canonical path, apply scope/type filters before the final limit, and preserve qmd ranking among remaining equal-priority candidates with canonical-path tie breaks. Never treat a repository source path mentioned in a note as a vault file to open.

Read candidate results against the command inventory. Reject deleted/out-of-scope paths; construct title, description, digest, and excerpt from current captured bytes, not the indexed excerpt. If candidate content changed after indexing, mark retrieval coverage incomplete and never attach an old snippet to the new digest. Revalidate result paths/digests before emitting; a detected moving target is omitted with a diagnostic rather than repeatedly retried. Changes after the final read remain possible; the digest names the captured bytes, not a frozen filesystem.

Search returns separate `textCoverage`, `embeddingCoverage`, and diagnostics. Each coverage value is complete, incomplete, or unavailable, scoped to the request and captured inventory. When useful qmd lexical or literal matches remain after a vector/model failure, return them with explicit degraded mode and incomplete/unavailable coverage. Do not present a no-hit degraded result as an exhaustive search. If no usable search operation can run, exit 7 with a dependency error. A failed or interrupted sync never marks coverage complete.

These statements must not be collapsed:

1. Displayed text comes from a current captured Markdown revision identified by digest.
2. Text indexing covered a particular inventory.
3. Embeddings covered some or all current indexed contents.
4. The notes claims agree with external source reality.

The first three can be checked mechanically. This release does not assert the fourth. No trust labels, evidence checks, source-graph attestations, classifiers, or freshness guarantee from file timestamps are introduced.

### D13: explicit source capture

Capture remains in scope. Deferring historical import is not permission to remove external sources. Support:

- UTF-8 text and Markdown files: .txt, .text, .md, .markdown.
- PDF files with a text layer, through pdftotext.
- Explicit HTTP/HTTPS resources with text/plain, text/html, application/xhtml+xml, or application/pdf response types.

Refuse unsupported extensions/media, corrupt files, and undecodable text with a precise limitation. A scanned PDF with no text layer retains its original, records empty extracted text and an explicit no-text limitation, and does not claim OCR. Text/Markdown import is document capture, not direct promotion to a maintained reference or decision.

Retain exact original bytes and full UTF-8 extracted text as separate assets under the chosen scope. A source note carries `resource`, `retrieved`, `original`, `original_sha256`, `extracted`, `extracted_sha256`, `extractor`, `extractor_version`, `media_type`, optional `final_resource`, and optional flat `limitations` string list. Asset paths are canonical vault-relative metadata values; Markdown links to those assets are relative. Digests name retained bytes, not evidence-backed truth. Captures have no check outcome or authenticated reviewer.

The source note includes the full extracted text in a literal block with a delimiter that cannot be closed by the input. Original/extracted assets preserve byte fidelity even when rendered Markdown needs a final newline. Link/heading lint does not interpret raw captured material as authored wiki structure. Search can still retrieve its text. Captured instructions remain untrusted content.

Capture takes caller-supplied title, description, and scope. The CLI does not generate them with a model. Capture requires a registered `source` type and validates its configured folder/scope; if it is absent, return an actionable registry error rather than reinstalling it. A repeated existing capture path conflicts; there is no source-request claim ledger, automatic deduplication, or guessed overwrite. Distinct explicit captures can retain identical bytes without pretending that an earlier observation proves the later one.

Adapt the existing extraction algorithms without importing evidence, check, note-ID, or request-claim policy. Reuse the tested Pandoc AST text rendering, charset handling, PDF flags, and cancellation behavior. HTML extraction uses `pandoc -f html-smart -t json --sandbox`; PDF uses `pdftotext -enc UTF-8 -eol unix -nopgbrk`. Scripts are not executed. Page links, images, and iframes are not fetched. Redirects retain requested and final URL; only the explicit request and its redirects are fetched. Only HTTP/HTTPS redirect destinations are supported. No session cookies, credential discovery, or ambient authorization headers are added.

Extract before publishing any source note. Missing programs, HTTP errors, unknown Pandoc node types, cancellation, and decoding errors publish no source note or success log line. Partial ancillary assets after an interrupted publication are reported; do not claim multi-file atomicity or delete unrelated data. SIGINT/SIGTERM must abort the request/extractor and allow child-process cleanup. Reads of a retained source never refetch it. The absence of an automatic resource-size limit in reused code must be documented; the first release has no crawler, unbounded retry loop, or new implicit import job.

### D14-D15: explicit skill-to-agent handoff

The repository skill is one self-contained Agent Skills-compatible file named SKILL.md, with its own name and description. That file holds the full workflow, every branch rule, the explicit handoff rules, and a completion check on each step. Order the steps. Keep each rule in the file beside the step that uses it, and state the action to take. Follow writing-for-agents for that hierarchy, those positive instructions, and those completion checks. Keep branch-only rules in the same file. The dedicated agent definition remains its own runtime role. CLI schemas remain registry data. Do not add an auxiliary skill, a reference document, a router skill, or a required instruction that appears only in the agent example. It teaches this sequence: scope index when useful, fast find, show selected sections, deep find only on a miss, distilled handoff, then lint/index checks for actual writes. It does not require reading a whole-vault index or loading an old roster. Report measured skill context cost in tokens, with the tokenizer named; there is no invented token budget acceptance threshold.

The inactive repository-owned dedicated agent example defines its wiki role, permitted CLI operations, registry restrictions, review rules, conflict handling, and result contract. Its model is configurable at installation/invocation, with no selected maintenance provider. Do not hard-code Grok, Sol, Opus, DeepSeek, or a credential route into the maintenance template. The owner requested Sol for engineering. That routing does not select a wiki maintenance model; Grok Fast helpers are not a chosen maintenance model.

A handoff contains:

- Explicit target vault and scope.
- Distilled findings or procedure/architecture content, source references, and relevant limitations.
- Existing topic paths when known; otherwise an instruction to search.
- Permitted action: explicitly authorized create or factual update, or proposal when write authority is absent. Authorized factual updates apply directly within the stated scope; decisions/intent still require owner approval.
- For an update, the reviewed target path and base digest, plus the bounded content scope.
- Any owner decision that the agent must not reinterpret.

A handoff does NOT include the full session file, transcript, tool logs, credentials, or arbitrary personal data. A source pointer is not permission to ingest everything at that location. The wiki agent does not open transcript history unless a separate task explicitly authorizes the particular source content.

The wiki agent must search before creating, read a target before updating, use the actual registry, and explain any conflict rather than invent a replacement path. It may organize reusable derived findings within the allowed action. It must return decision/intent/policy changes and changes to personal meaning as proposals for owner review. It cannot authenticate that review through frontmatter or a CLI flag. A schema change is also a proposal, not an autonomous agent fix.

When a proposal is needed, candidate output goes to the caller’s authorized artifact location and can use `update --dry-run`; it makes no maintained-vault change. Dry-run remains available, not mandatory for every task. An explicit handoff can authorize direct factual updates under D09’s exclusive-edit workflow. The agent validates schema and the exact expected full-file digest, serializes cooperating CLI writers, then reads the base immediately before atomic replacement and rejects detected conflicts. After a detected conflict, return the latest digest and ask the working agent/owner to re-read and reconsider; do not retry an old generated candidate against a newly sampled digest.

Return changed/proposed paths, checks and outcomes, conflicts, and source limitations. Do not claim knowledge was maintained when only a candidate was produced. All templates remain repository-owned. Installing them globally, changing the active roster, selecting a hosted model, and sending real vault contents to a provider require separate authorization.

### D16: module and reuse choices

Prefer one deep CLI-owned knowledge module with small deterministic operations, not a new general framework. Use a simple command adapter and a narrow search adapter because the external qmd engine is a real variable and failure seam. Use the filesystem as the real collaborator. External extraction processes, network responses, and model execution are nondeterministic seams. Do not add speculative storage backends, task schedulers, provider routers, or extension frameworks.

Run the new private package from sources with Node built-in TypeScript stripping, retaining the existing Node >=22.18 convention. The tested support claim must name the actual Node version and qmd native compatibility. A higher minimum is an engineering issue only if the pinned SDK demonstrably requires it; do not silently claim an untested minimum.

Reuse/adapt the safe YAML parsing, exclusive complete-file creation, full-byte hashing, basic CLI parsing, JSON error mapping, and real-process disposable-vault test patterns. Port the useful index sorting and rendering behavior, not legacy IDs, wikilinks, Bun-specific runtime calls, mtime caches, background qmd updates, or template schema DSL. Do not import the old note loader: it requires frontmatter IDs and authority classes and scans the vault per lookup.

The implementation will need a real JSON Schema validator and a Markdown parser because existing declared dependencies do not supply those contracts. Prefer small established libraries over a home-grown JSON Schema evaluator or link regex. Exact releases are pinned and recorded when dependencies are installed. These are routine dependency choices, not permission for another search engine.

### D17: delivery and verification contract

Use the CLI process as the principal seam for user-visible behavior. Preserve pure focused tests for extraction and deterministic rendering where they isolate a real failure mode. Reuse the existing test harness patterns; do not duplicate evidence/trust tests in the new package.

Only external network and model/process failure boundaries may be faked where nondeterminism is the subject. A fake qmd result is not proof that real SDK indexing, SQLite, collections, or query modes work. Keep a real SDK text-index test and a local-model smoke proof. No hosted prompt is needed.

## Testing Decisions and Observable Acceptance

| ID | Observable acceptance |
| --- | --- |
| AC01 | A Node subprocess initializes a fresh disposable vault, then type list and lint succeed. Repeat init preserves authored bytes; foreign/unsupported vaults are refused. |
| AC02 | Add a custom eighth type as registry data. A valid note passes; unknown type, invalid schema, forbidden folder, missing field, and scope mismatch fail with rule/path/hint. No source edit is required. |
| AC03 | Lint rejects missing description, wrong lifecycle, missing required body headings, duplicate scoped title, and actual body metadata duplication. Code examples are not mistaken for structure. |
| AC04 | Relative local links and references resolve. Broken links, wikilinks, leading-slash internal links, traversal/percent-decoding escape, unsafe schemes, and symlink escape fail. External links cause no network access. |
| AC05 | Two index runs over unchanged bytes produce identical output. Edit with unchanged size/mtime, rename, delete, missing index, and changed description cause check failure until regeneration. |
| AC06 | Create produces a valid path/profile/template and current indexes/log entry. Same destination or scoped title conflicts without overwriting. Separate scopes can use the same title. |
| AC07 | Show returns current bytes/section and the whole-file digest. Duplicate/missing section names fail. A whitespace-only note edit changes the digest. |
| AC08 | An authorized factual update with the observed base applies directly under the exclusive-edit contract, without a mandatory proposal step. Old-base, missing target, invalid candidate, and dry-run leave all vault bytes unchanged. No-op update produces no log entry. |
| AC09 | Two real cooperating CLI processes applying candidates against one base produce one success and one conflict. A synchronized external edit before the final digest comparison is preserved and rejected. No test claims that the later external-editor race is solved. |
| AC10 | A busy lock is an actionable conflict. Faults after note publication report written state, current digest, and repair instructions, not a false rollback or silent success. |
| AC11 | Real qmd SDK indexes a temporary scope into temporary storage. No global collection/config/database/model-cache changes occur. Generated/operational/assets content is excluded. |
| AC12 | Fast mode forwards one typed lex/vec request with rerank false and no expansion; deep mode explicitly expands and reranks. A real local-model smoke test exercises both, with runtime and model names recorded. |
| AC13 | Search reflects additions, same-size/restored-mtime edits, deletions, and renames. Every returned excerpt/digest comes from the same current captured note revision. A stale indexed excerpt never leaks as current. |
| AC14 | Failed/interrupted sync and pending embeddings never report complete coverage. Useful degraded matches are clearly labelled; unusable search fails explicitly. Rebuilding deleted local search state restores retrieval. |
| AC15 | A note mentioning a literal path or dotted filename is found even when qmd misses it. Merge order, deduplication, scope/type filters, and result limit remain deterministic. |
| AC16 | Text capture preserves original/extracted bytes and source metadata. Source content cannot close its literal block or become authored headings/links. Unsupported/invalid input publishes no source note. |
| AC17 | Synthetic PDF fixtures retain original bytes, expected extracted text, and extractor version. Empty layer, corrupt PDF, missing tool, and cancellation have explicit outcomes. No OCR is implied. |
| AC18 | A local HTTP fixture verifies HTML/text/PDF capture, redirects, charset handling, no linked-resource fetch, HTTP failures, sandbox extraction, unknown AST failure, and retained reads after the server stops. |
| AC19 | One repository-owned SKILL.md, written to writing-for-agents, holds the workflow, branch rules, handoff rules, and completion checks. Repository templates define explicit distilled handoff, search-before-create, direct authorized factual updates, owner approval of decisions/intent, optional dry-run, digest refusal, no transcript harvest, no hooks, no installed paths, and no hard-coded maintenance model. |
| AC20 | A synthetic handoff drives the real CLI through search/read, candidate validation, authorized create/update, lint, and index check in a disposable vault. This proves the protocol and CLI, not live model judgment or real-data egress policy. |
| AC21 | A boot check starts the Node CLI, runs init/new/show/lint/index-check in temporary storage, and exits cleanly. Search smoke uses isolated qmd state. No root dist build, archive write, global install, or blanket Git staging occurs. |

Race/failure tests must synchronize on observable reads, extraction start, or publication events, using process coordination or a narrow internal test seam. Do not force ordering with sleep/poll delays. Keep the public CLI free of test-only behavior flags.

Verification commands to establish during package setup:

- `heavy -- bun run typecheck:wiki`: the new package checker.
- `WIKI_TEST_PATTERN="wiki:NN" heavy -- bun run test:wiki`: the affected slice test group, where NN is its ticket number.
- `heavy -- bun run verify:wiki`: standalone new-package typecheck plus all new-package tests; do not repeat it at landing when the expanded `verify:next` already covers that exact scope.
- `heavy -- bun run boot:wiki`: disposable CLI boot check; no build or root dist output.
- `heavy -- bun run verify:next`: established Node-package integration suite, extended to check the new package at batch gates (now only `packages/wiki`; see the 2026-11-09 notes).
- The legacy CLI and its checks were removed (#38); no legacy verification scope remains.

The test script must place the name-pattern option before test file arguments and read the optional `WIKI_TEST_PATTERN` environment value; affected runs must not accidentally run every test. Full CI/local policy follows repository guidance. No test, checker, build, extractor run, or model call was executed while writing this local contract.

## Delivery Slices

These are the bounded delivery slices; their ticket drafts are local, not published issues. Each targets one 20-30 minute worker run after its dependencies are green. Preserve these 20 delivery tickets; if an estimate fails, report the narrower implementation plan before growing scope. File ownership and remaining mechanisms are in the local final readiness record; exact ticket bodies and blockers are in the local publication package.

| Local ID | Bounded outcome | Blocked by | Decisions |
| --- | --- | --- | --- |
| B01 | Node entry point, safe profile init, and disposable test/check scripts. | None | D01-D03, D05, D08, D16-D17 |
| B02 | Registry-driven frontmatter lint and custom-type/list/scaffold behavior. | B01 | D04-D05, D08 |
| B03 | Body, lifecycle, folder/scope, and scoped duplicate-title lint. | B02 | D03-D05, D08 |
| B04 | Relative Markdown link validation and contained canonical path access. | B03 | D03, D06, D08 |
| B05 | Deterministic generated indexes and stale-index lint/check. | B04 | D07-D08 |
| B06 | Current show/section reads with whole-note digest. | B04 | D03, D08-D09 |
| B07 | Validated exclusive note create, cooperative lock, indexes, and normal log entry. | B05 | D03-D09 |
| B08 | Expected-digest update and zero-effect dry-run. | B06, B07 | D08-D09, D14 |
| B09 | Visible busy/concurrent/conflict and partial-publication outcomes. | B08 | D07-D09, D17 |
| B10 | Isolated real qmd text synchronization and coverage inventory. | B06 | D10, D12, D16-D17 |
| B11 | Fast typed hybrid/deep find and explicit current embedding synchronization. | B10 | D10-D12 |
| B12 | Current search rendering and honest edit/delete/rename/failure coverage. | B11 | D08, D12, D17 |
| B13 | Literal path matches, filters, deduplication, and bounded result order. | B12 | D03, D11-D12 |
| B14 | Explicit UTF-8 document source capture and retained source assets. | B07 | D05-D07, D09, D13 |
| B15 | PDF capture through existing extraction behavior. | B14 | D13, D16-D17 |
| B16 | Explicit web capture through safe extraction behavior. | B15 | D13, D16-D17 |
| B17 | Read-only doctor reports package, extractor, registry, and search readiness. | B05, B10, B15 | D08, D10-D13 |
| B18 | Repository-owned one-file wiki skill. | B08, B13 | D01-D02, D14-D15 |
| B19 | Repository-owned dedicated wiki-agent handoff template and protocol fixture. | B09, B16, B18 | D01-D02, D09, D13-D15, D17 |
| B20 | Disposable complete CLI boot/handoff smoke, support documentation, and batch verification wiring. | B13, B16-B17, B19 | D01-D17 |

Search does not block basic structural correctness or safe reads/writes. Source capture does not block core structure. Model provisioning, real import, taxonomy refinement, and global cutover are not hidden blockers of B01.

## Out of Scope

- Pi extension tools, Code Mode wrappers, event hooks, pre-commit installation, background runners, durable queues, automatic capture, and scheduled maintenance.
- Evidence logs, authority classes, check requests, attestations, trust tiers, CLEF, source-graph evaluation, or automatic correctness claims.
- A second search engine, owned SQLite FTS5 stack, custom vector pipeline, new ranking algorithm, or a benchmark to reselect qmd.
- Unattended in-place publication, authenticated review records, semantic conflict resolution, external-editor locking, and multi-machine coordination.
- Live model evaluation, provider selection, credential changes, vault-content egress, new hosted service accounts, or model spending.
- Historical-vault migration, classification of 710 old specs, project retirement/restoration, personal-note import, and any archive changes.
- A permanent pilot-vault location, a published package, and moving to another repository.
- Owner decision 2026-11-08: the new CLI ships as `wiki` and replaces the legacy binary at release; the repository skill replaces `skills/wiki/SKILL.md`; the legacy code is removed after the new install is verified. Global skill, agent, and CLI installation and the cutover itself stay outside this specification until release.
- 2026-11-09: after the new install was verified, the legacy Bun CLI (root `src/`, `tests/`, templates, root build wiring, and its mutation plan) was removed (#38). The batch gate is `verify:next` plus `boot:wiki`.
- 2026-11-09: the architecture and performance pass ([wiki-architecture-pass.md](wiki-architecture-pass.md)) supersedes D16 for wiki-core and wiki-cli and amends D17 with an in-process command interface.
- 2026-11-09: per decision A2 of that pass, the earlier Node packages `packages/wiki-core` and `packages/wiki-cli`, their typecheck include, mutation plan, and the root `gray-matter` dependency were removed (#41); git history keeps the code.
- Automatic Git staging/commits, general rename/backlink migration, OCR, unsupported attachment formats, link crawling, and network correctness checking during reads or lint.

## Further Notes

### Reconciliation and deferred choices

This file replaces the evidence-first plan in place, rather than adding a parallel specification. Earlier standards drafts are not a second current specification. This build does not delete or rewrite historical artifacts.

Latest qmd amendments supersede all FTS5-default text and the old delivery slice that would decide whether qmd is needed. Registry amendments supersede a fixed seven-type implementation. CLI + explicit handoff supersedes extension/hook/Durable delivery. Relative Markdown links avoid making an unsupported root-link compatibility promise.

The owner has chosen direct authorized apply with D09’s exclusive-edit limitation. No additional owner choice between candidate-only and direct apply remains. Lossless simultaneous external editing is not promised. Deferred choices include permanent vault/import locations, final personal organization, old spec classification, project lifecycle, maintenance model/provider/egress/spending policy, and installed cutover. None blocks the disposable foundation. Exact GitHub ticket/comment publication remains an owner checkpoint.

### Compact ADR record: path identity and configurable profile

Decision: use canonical scoped topic paths and a reviewed type registry rather than legacy numeric IDs or a compiled fixed taxonomy.

Context: the old vault mixed knowledge with work records. A fixed taxonomy would make every owner taxonomy change a software release; legacy IDs require a second identity resolver and migration policy.

Alternatives: retain numeric IDs, compile the seven seeds, or adopt an unconstrained folder tree.

Consequences: the CLI can enforce a discoverable profile without a runtime change for each type. A rename changes identity and can break references; lint detects those breaks and this release does not promise automatic migration. Registry changes require whole-vault validation. This is the meaningful migration trade-off, not a reason to create a second evidence model.

### Verification status and publication boundary

This specification reconciles the approved local build-contract and readiness drafts with the confirmed direct-update choice. It defines acceptance, not completed implementation. No typecheck, test, build, extractor, qmd/native import, local-model run, or provider call was performed for this documentation change.

The inventory reports local qmd source 2.5.2 and installed qmd 2.5.3; neither chooses the product pin or proves compatibility. B10 must verify and pin the public release current at implementation, record the actual Node/native support, and prove isolated real text indexing. B11 must prove real local-model fast/deep behavior. Source inspection and forwarding tests cannot substitute for those runs.

There is no CI at baseline. All checks run through `heavy`. At local batch landing, run full new-package and existing Node-package verification once: `heavy -- bun run verify:next` (expanded to include the new package), plus `heavy -- bun run boot:wiki`. The standalone `verify:wiki` is not an additional duplicate full run. Existing Node typecheck includes only wiki-core/wiki-cli at baseline (now only `packages/wiki`; see the 2026-11-09 notes); B01 must include the new package in both root verification wiring and Node typecheck, not merely a test glob. No root bundle build is permitted. These are implementation gates, not checks executed for this documentation-only change.

Publication target is `FasalZein/wiki`. The local 20-ticket package references this canonical file. The exact shared comment for old #9-#14 states supersession, not implementation; after exact-text owner approval, close them as not planned. No GitHub write, archive change, global install, model egress, or cutover is authorized by this file.
