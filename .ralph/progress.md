# Ralph progress — PRD-0018 + PRD-0019

## SLICE-0108 SPIKE — read-only search membership contract (PASS)

Selected as the lowest-numbered unfinished item with no blockers.

Decision rationale: PRD-0018's read-only search slice (SLICE-0109) needs to know
whether `qmd query` against a registered-but-never-embedded collection errors or
returns empty, to decide if its warn-and-skip branch must cover present-but-
unembedded collections or only entirely-absent ones.

Method: the real `qmd` binary (2.5.3) is present at /opt/homebrew/bin/qmd, so I
characterized it empirically against throwaway temp indexes (QMD_HOME pointed at a
mktemp dir; the real $HOME/Knowledge vault was never touched), then pinned the
observed contract into a deterministic fake-qmd in the test so the suite does not
depend on the binary.

Finding (recorded atop tests/qmd-unembedded-collection.test.ts as well):
- registered-but-never-embedded -> `qmd query --collection <name>` returns LEXICAL
  results, exit 0, stderr embeddings warning only. NOT an error, NOT empty.
  `collection add` indexes lexically up front; embed only improves vector ranking.
- absent / never-added -> "Collection not found: <name>" on stderr, exit 1 (hard
  error; runQmd turns exit!=0 + empty stdout into a thrown QmdError).
- empty index, no --collection -> `[]`, exit 0.

Consequence for SLICE-0109: warn-and-skip applies ONLY to entirely-absent
collections (the ones that error at the integration surface). A present-but-
unembedded collection is an ordinary queryable collection and must be queried, not
skipped.

Files changed:
- tests/qmd-unembedded-collection.test.ts (new characterization test, 3 cases)
- .ralph/items.json (SLICE-0108 passes false->true)
- .ralph/progress.md (this entry)

Substitute used: fake-qmd bash script reproducing the real binary's exit/stdout/
stderr contract. What remains unverified against a future real-binary upgrade: the
exact stderr/warning wording and exit codes are pinned to qmd 2.5.3 as observed;
if qmd changes its "Collection not found" message or starts erroring on unembedded
collections, SLICE-0109's branch assumptions would need re-checking. The behavioral
classes (error vs results-with-warning) are what the spike commits to.

Verification (all green at this commit):
- bun run build: ok (bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 376 pass, 0 fail, 1202 expect() calls, 47 files

Next-iteration notes: SLICE-0109 (read-only search) is now unblocked. It should
drop the per-query refresh from search.ts, collapse N ensureCollection probes into
one `qmd collection list`, query only listed collections, and warn-and-skip absent
collections per this finding. Update the two pinned tests/search-upgrade.test.ts
cases (auto-refresh-by-default, --no-refresh-skips-update) to the read-only
contract rather than deleting them.

## SLICE-0109 READ-ONLY SEARCH (PASS)

Selected as the lowest-numbered unfinished item; its only blocker SLICE-0108 is
passes:true.

Decision rationale: make `wiki search` a pure read against whatever `wiki sync`
last produced. Search previously ran a per-collection `qmd update` refresh and an
ensureCollection probe per project before querying; both are dropped from the read
path.

Implementation:
- src/cli/verbs/search.ts: replaced the per-project ensureCollection probes with a
  single `listCollections(qmdCommand)` call up front. The returned set is used to
  decide which collections to query and to detect never-synced ones: an absent
  project collection is warned to stderr ("skipping <name>: never synced — run:
  wiki sync --project <name>") and skipped, never silently auto-registered. The
  research collection (under --include-research) follows the same present-or-skip
  rule. If no targeted collection is present, search emits a "no synced collections"
  notice and returns an empty result set (code 0). Removed the `refreshCollections`
  call entirely. Honored the SLICE-0108 finding: a present-but-unembedded collection
  is in the list and is queried (it yields lexical hits); only entirely-absent
  collections are skipped.
- The `--no-refresh` flag is now an accepted no-op (read-only is the default). Kept
  parseable so existing invocations don't error; marked with a ponytail comment.
- Dedup's create-time refresh is untouched: src/artifacts/dedup.ts still calls
  ensureCollection + refreshCollections in runDedupGate. The split is asserted by
  test (search logs show zero update/embed; dedup path unchanged).
- skills/wiki/SKILL.md: dropped the "search updates only the keyword index" promise;
  now states search is a pure read against the last sync and warns-and-skips
  never-synced project collections.

Tests:
- tests/search-upgrade.test.ts: pre-register the project collection in the fixture
  (read-only search only queries listed collections). Reframed "--no-refresh skips
  updateCollection call" to "--no-refresh is accepted and search never calls update";
  replaced "auto-refresh runs by default" with "search is read-only by default: no
  update/embed, exactly one collection list". Added a new case proving a never-synced
  sibling project is warned and skipped, never auto-registered (no `collection add`).
- tests/cli-search.test.ts: pre-seed the project collection in the fixture; updated
  the enriched-lines, repeated-calls, and include-research cases to the read-only
  contract (no `collection add`, no `update`; query the pre-synced collection).
- tests/cli-vault-wide.test.ts: pre-register every project in makeVault so the two
  vault-wide query cases exercise real queries under the read-only contract.

No test was deleted or weakened; each pinned refresh-on-search assertion was
explicitly rewritten to the new read-only contract.

Verification (all green at this commit):
- bun run build: ok (bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 377 pass, 0 fail, 1207 expect() calls, 47 files

Next-iteration notes: PRD-0018 is complete (0108 + 0109). The next unblocked item
is SLICE-0110 (Structure tree skeleton, no blockers) — the start of PRD-0019.

## SLICE-0110 STRUCTURE TREE SKELETON (PASS)

Selected as the lowest-numbered unfinished item; it has no blockers and starts
PRD-0019.

Decision rationale: extend the per-vault method-based `Structure` from a flat
kind map into a one-level section/bucket tree, as a walking skeleton — the type
and loader carry the tree end-to-end and validate it; create/doctor/relocation
behavior changes land in later slices. The bundled default tree must reproduce
today's five kinds + six doc categories byte-for-byte so an unconfigured vault
is unaffected.

Implementation (src/artifacts/registry.ts only — no consumer migration this slice):
- Added two tree types: SectionSpec (a top-level folder owning a prefix and a
  single shared id-space, tagged tree:"leaf"|"branch", with a non-empty buckets
  array) and BucketSpec (name, folder, template, optional criteria).
- Structure gained a `sections` field; every existing method (specFor, typeForId,
  artifactTypeForVaultPath, kindForSkill) and `folders`/`kinds` are unchanged and
  still derive from the flat kind map, so default-vault behavior is byte-identical.
- buildStructure(kinds, bucketsByKind?) now also calls buildSections to expand the
  flat kinds + per-kind declared buckets into the tree. A kind with no declared
  buckets becomes a LEAF (one self-named bucket filing into the section folder);
  a kind with declared buckets becomes a BRANCH (each bucket files into
  <folder>/<bucket>). The branch-XOR-leaf invariant and globally-unique bucket
  names are validated here, throwing loudly.
- parseBuckets reads the optional per-kind `buckets` map from config: each bucket
  entry is an object with optional criteria/template strings; a bucket may not
  declare nested `buckets` (one-level tree). Malformed shapes throw before any
  write.
- DEFAULT_BUCKETS models `doc` as the one default BRANCH with six buckets
  (architecture/research/runbooks/specs/notes/legacy) reproducing the locked
  DOC_CATEGORIES (ADR-0028) exactly — each files into docs/<category>/, shares
  the DOC prefix and id-space, uses the doc template, and carries a criteria
  string. DEFAULT_KINDS is unchanged (byte-compatible). DOC_CATEGORIES /
  isDocCategory / defaultCategoryForDocType are left in place for now (their
  deletion is SLICE-0117, after consumers migrate).
- loadStructure threads parseBuckets(rawKinds) into buildStructure so a custom
  wiki.json declaring buckets produces a branch section, and a config with no
  buckets stays all-leaf.

Conservative assumptions recorded:
- "branch-and-leaf node" is enforced two ways: a section with an empty `buckets`
  object (neither branch nor leaf) errors, and a bucket that itself declares
  `buckets` (a second tree level) errors. Both are reversible config-shape rules.
- The default doc bucket criteria strings are descriptive paraphrases of the
  locked-category intent; they are informational metadata surfaced in a later
  slice and do not affect behavior.

Tests (tests/structure-tree.test.ts, new — 9 cases): default exposes one section
per kind; the four artifact kinds are leaf sections with a self-named bucket;
doc is the one branch with six DOC-prefixed buckets filing into docs/<category>/;
existing flat lookups are byte-identical; the loader carries the default tree and
a custom branch tree end-to-end; and three malformed-tree cases (duplicate bucket
name, empty buckets, nested buckets) hard-error at load. No existing test was
weakened.

Files changed:
- src/artifacts/registry.ts (tree types, buildSections, parseBuckets, default
  doc-branch buckets, loadStructure wiring)
- tests/structure-tree.test.ts (new)
- .ralph/items.json (SLICE-0110 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB)
- bunx tsc --noEmit: clean
- bun run test: 386 pass, 0 fail, 1255 expect() calls, 48 files

Next-iteration notes: SLICE-0111 (per-section id allocation) is now unblocked.
It should generalize src/artifacts/id.ts nextId() and the id-index builder to key
on the SECTION (so buckets under one branch share one increasing id-space keyed
on the section prefix) while keeping the default tree's single-bucket kinds on
their current sequences. The section model it needs is now on Structure.sections.

## SLICE-0111 PER-SECTION ID ALLOCATION (PASS)

Selected as the lowest-numbered unfinished item; its only blocker SLICE-0110 is
passes:true.

Decision rationale: move id allocation from per-kind to per-section so all
buckets under one branch section draw from a single increasing id-space keyed on
the section's prefix. This is the mechanism a later intra-section move needs to
preserve identity. Under the bundled default tree it preserves today's per-kind
sequences exactly.

Implementation (src/artifacts/id.ts only):
- nextId() already keys on structure.specFor(type).prefix (the section prefix)
  and scans the section folder returned by artifactDirectory(type). The ONLY
  per-kind special case was the filename scan: docs scanned recursively (to cover
  category subfolders sharing the DOC id-space) while every other type did a flat
  readdir. Generalized that single branch — the filename scan is now always
  recursive over the section folder. A branch section's bucket subfolders are
  therefore all covered by one scan keyed on the section prefix; a leaf section
  has no subfolders so a recursive scan equals the old flat read (byte-identical
  result for prd/slice/adr/handoff).
- The frontmatter id-index path (highestFrontmatterId -> buildIdIndex) already
  keys on the section: buildIdIndex walks every project folder and nextId filters
  its keys by the section prefix regex, so a branch section's buckets already
  shared one frontmatter id-space. No change needed in id-index.ts.

Conservative assumption recorded: making the non-doc scan recursive also makes a
missing section directory return empty instead of throwing (readMarkdownNamesRecursive
swallows ENOENT). This is strictly safer for allocation (start at 0001 instead of
crashing) and reversible; no existing test depended on the throw.

Tests (tests/section-id-allocation.test.ts, new — 4 cases): on a custom branch
section `feature` (prefix FEAT) with buckets alpha/beta filing into separate
subfolders, allocation sees across buckets and returns FEAT-0003 (one shared
counter, not two per-bucket counters); an empty multi-bucket section starts at
0001; default-tree leaf kinds keep their flat per-kind sequence (PRD-0003,
SLICE-0001); the default doc branch stays globally unique across its category
buckets (DOC-0010). No existing test was weakened; the pre-existing
id-generation.test.ts doc-recursive case and structure-loader nextId tracers still
pass unchanged.

Files changed:
- src/artifacts/id.ts (always-recursive section scan; comment update)
- tests/section-id-allocation.test.ts (new)
- .ralph/items.json (SLICE-0111 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 390 pass, 0 fail, 1260 expect() calls, 49 files

Next-iteration notes: SLICE-0112 (create by bucket/leaf name) is now unblocked
(blockers 0110 + 0111 both pass). It should make `wiki create <name>` resolve a
bucket/leaf name to its section (prefix + id-space) and template, file into the
bucket folder with a section-prefixed id, error on unknown name, and migrate
src/cli/verbs/create.ts + src/artifacts/store.ts off DocCategory/isDocCategory so
no dangling doc-category type remains for the SLICE-0117 deletion.
