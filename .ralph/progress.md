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

## SLICE-0112 CREATE BY BUCKET/LEAF NAME (PASS)

Selected as the lowest-numbered unfinished item; its blockers SLICE-0110 and
SLICE-0111 are both passes:true.

Decision rationale: `wiki create <name>` now resolves <name> to a bucket/leaf in
the section tree (not just a section kind), files into the bucket folder with a
section-prefixed id, and the create path no longer touches DocCategory — the
first of the four migrations the SLICE-0117 deletion needs.

Implementation:
- src/artifacts/registry.ts: added a `bucketFor(name)` lookup to the Structure
  seam (precomputed bucket-name -> {section, bucket} map in buildStructure, built
  off the already-validated unique bucket names). No behavior change to existing
  methods; purely additive.
- src/cli/verbs/create.ts (the migration off DocCategory): handleCreate resolves
  the create-name against the bundled DEFAULT tree synchronously (so an unknown
  name still fails before any vault load — the `create bogus` contract runs with
  no vault configured): a section kind (e.g. `doc`) goes straight to createGeneric;
  a branch bucket name (e.g. `architecture`) resolves to its section + a preset
  category subfolder; a leaf name files into the section folder with no preset.
  createGeneric now loads the per-vault Structure up front and validates an
  explicit --category against THAT section's declared bucket names (replacing the
  isDocCategory/DOC_CATEGORIES enum check). The legacy `wiki create doc --type X`
  default bucket map (runbook->runbooks, research->research, else->notes) is
  inlined locally as `defaultDocBucket` and gated to kind==="doc"; it is back-compat
  for the doc `type` enum that SLICE-0117 removes. Dropped the
  defaultCategoryForDocType / DOC_CATEGORIES / isDocCategory / DocCategory imports
  entirely from create.ts. Threaded vaultRoot + structure through CreateRequest so
  createWithSupersede no longer re-loads them.
- src/artifacts/store.ts: CreateArtifactInput.category is now `string` (a bucket
  subfolder) instead of `DocCategory`; artifactPath files into the subfolder for
  ANY kind when category is set (dropped the `type === "doc"` guard). The relocate
  path (RelocateArtifactInput.category, isDocCategory in relocateArtifact) still
  imports DocCategory — that migration is SLICE-0115, so store.ts keeps the import
  for now. No dangling doc-category type remains on the CREATE path.

Consumers NOT touched this slice (still on the old machinery until their own
slice): src/cli/verbs/doc.ts recategorize (SLICE-0115), src/bootstrap/doctor.ts
(SLICE-0113), and store.ts relocate (SLICE-0115). registry.ts still exports
DOC_CATEGORIES/isDocCategory/defaultCategoryForDocType/DocCategory (deleted in
SLICE-0117 after all consumers migrate).

Conservative assumptions recorded:
- A branch section other than `doc` with no explicit --category and no preset
  bucket files straight into the section folder (category undefined). No default
  tree has such a section, and doctor (SLICE-0113) will flag a loose file in a
  branch section, so this is a reversible, safe default rather than inventing a
  fallback bucket.
- bucket.template overrides are honored by the registry data model but the create
  path keeps filing under the section template (type === section name); under the
  default tree every bucket's template equals its section, so this is byte-identical.
  A genuine per-bucket template override is out of scope until a slice demands it.

Tests (tests/create-by-bucket.test.ts, new — 5 cases): create <branch-bucket>
(`architecture`) files into docs/architecture/ with a DOC id and the doc template;
create <leaf-name> (`prd`) files into prds/ with a PRD id; an unknown name errors
"unknown artifact type" and lists the kinds; --category is subsumed (names a
bucket of the section and files there); an unknown --category bucket errors against
the loaded tree. No existing test was weakened; the pinned cli-doc.test.ts and
cli-create-path-echo.test.ts contracts (create doc --category / --type default)
still pass unchanged because the hybrid path preserves them.

Files changed:
- src/artifacts/registry.ts (bucketFor lookup)
- src/artifacts/store.ts (create category -> string; generic subfolder path)
- src/cli/verbs/create.ts (resolve by bucket/leaf name; migrate off DocCategory)
- tests/create-by-bucket.test.ts (new)
- .ralph/items.json (SLICE-0112 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 395 pass, 0 fail, 1272 expect() calls, 50 files

Next-iteration notes: SLICE-0113 (doctor structure-only) is unblocked (blocker
0110 passes). SLICE-0114 and SLICE-0115 are now also unblocked (both needed 0112).
Lowest-numbered next is SLICE-0113: reframe doctor's structural check in
src/bootstrap/doctor.ts to validate folders against the config tree (declared
section/bucket; no loose files in a branch section) instead of the hardcoded
DOC_CATEGORIES lock, READ-only (do not delete DOC_CATEGORIES — that is 0117).

## SLICE-0113 DOCTOR STRUCTURE-ONLY (PASS)

Selected as the lowest-numbered unfinished item; its only blocker SLICE-0110 is
passes:true.

Decision rationale: reframe doctor's structural validation to read the per-vault
config tree (PRD-0019) instead of the hardcoded DOC_CATEGORIES lock. The same
invariant (ADR-0028's no-loose-files) is now expressed through the section/bucket
tree: a branch section's folder may hold only its config-declared bucket subfolders
and no loose files. This slice only READS the tree; the dead DOC_CATEGORIES
machinery stays importable (its deletion is SLICE-0117).

Implementation:
- src/bootstrap/doctor.ts: checkProjectDocsStructure now takes the loaded Structure
  and iterates every BRANCH section (tree === "branch"). For each, it derives the
  allowed bucket subfolder names from section.buckets (folder minus the section
  prefix) and flags (a) any subdirectory that is not a declared bucket and (b) any
  loose .md file sitting directly in the branch folder. Leaf sections hold artifacts
  directly and are not policed for loose files. The check validates structural truth
  only and emits no fuzzy "wrong bucket" warning — a declared-but-debatable bucket
  choice is never flagged. Dropped the DOC_CATEGORIES import from doctor.ts (it is no
  longer read here); registry.ts still exports it for the not-yet-migrated consumers.
  runDoctor already had `structure` in scope and now threads it in.
- src/cli/verbs/sync.ts: the sync gate caller passes the already-loaded `structure`
  into checkProjectDocsStructure; updated the gate comment to reflect the
  config-declared invariant.

Behavior under the default tree is unchanged in substance: `doc` is the one branch
section (folder docs/) with the six default buckets, so a rogue docs/ subfolder or a
loose doc is still flagged — only the message wording changed from "not a locked
category" to "is not a declared bucket of section '<name>'".

Conservative assumptions recorded:
- Only BRANCH sections are policed for undeclared subfolders / loose files. Leaf
  sections (prds, slices, adrs, handoffs under the default tree) hold their artifacts
  directly, exactly as before, so they are intentionally not checked here. This
  preserves today's behavior (the old check only looked at docs/) and is reversible.
- Allowed bucket subfolder name is computed as bucket.folder.slice(section.folder.length + 1),
  relying on the registry's one-level "<section-folder>/<bucket>" convention from
  SLICE-0110; correct for every one-level tree the loader can produce.

Tests:
- tests/doctor-structure-tree.test.ts (new — 5 cases): an undeclared folder in a
  branch section is flagged; a loose file directly under a branch section is flagged;
  a valid-but-debatable bucket choice is NOT flagged (no fuzzy warning); a leaf
  section holding artifacts directly is not policed; and a CUSTOM wiki.json tree is
  validated against its own declared buckets, not the default categories (a default
  doc bucket name under a custom section is correctly flagged as undeclared there).
- tests/cli-sync.test.ts: updated the one pinned assertion from "not a locked
  category" to "is not a declared bucket" to match the new (config-driven) message;
  the sync-refuses-on-rogue-folder contract is otherwise unchanged. No test deleted
  or weakened.

Files changed:
- src/bootstrap/doctor.ts (config-tree validation; drop DOC_CATEGORIES import)
- src/cli/verbs/sync.ts (thread structure into the gate; comment)
- tests/doctor-structure-tree.test.ts (new)
- tests/cli-sync.test.ts (pinned message assertion updated to new contract)
- .ralph/items.json (SLICE-0113 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 400 pass, 0 fail, 1281 expect() calls, 51 files

Next-iteration notes: SLICE-0114 (generic parent backlink) is now unblocked
(blockers 0110 + 0112 both pass), as is SLICE-0115 (0111 + 0112). Lowest-numbered
next is SLICE-0114: replace the hardcoded PRD<->slice backlink in
src/cli/verbs/create.ts (both the pre-flight parent read and backlinkParentPrd write)
with a config-declared parent + child_list relationship, with no-double-add and
create-if-absent.

## SLICE-0114 GENERIC PARENT BACKLINK (PASS)

Selected as the lowest-numbered unfinished item; its blockers SLICE-0110 and
SLICE-0112 are both passes:true.

Decision rationale: replace the hardcoded PRD<->slice backlink with a
config-declared parent + child_list relationship so no kind name is hardcoded in
the create path. The PRD<->slice link is now pure config.

Implementation:
- src/artifacts/registry.ts: added two optional ArtifactSpec fields — `parent`
  (the parent kind a child backlinks to) and `child_list` (the list field on a
  parent that receives child ids). parseKinds validates both as optional strings.
  DEFAULT_KINDS now declares prd.child_list = "slices" and slice.parent = "prd".
  Added a pure helper `parentBacklink(structure, childType)` that resolves the
  parent kind, the child's parent-id field (convention: `parent_<parent>`, e.g.
  parent: "prd" -> field parent_prd), and the parent's child_list field. Returns
  undefined when the kind has no parent, the parent kind is unknown, or the parent
  declares no child_list — a config-incomplete relationship backlinks nothing
  rather than throwing. The helper does no I/O; the caller owns the reads/writes.
- wiki.json: the repo-root reference config now declares the same prd.child_list /
  slice.parent so a real vault loading wiki.json gets the relationship from config.
- src/cli/verbs/create.ts: replaced BOTH prd/slice specials. The pre-flight parent
  read (was `if (type === "slice" && fields.parent_prd...)`) now resolves
  parentBacklink(structure, type) and pre-flights whatever parent kind/field config
  declares. The backlinkParentPrd write was renamed/rewritten as the generic
  backlinkParent: it resolves the same backlink, reads the parent artifact, and
  appends the child id to the config-declared child_list field — no-double-add
  (skips when the id is already present) and create-if-absent (setField writes the
  list whether or not the parent had one). Both run inside createWithSupersede's
  rollback try block, so a missing/invalid parent still rolls back the child.
  Imported parentBacklink; no kind name (prd/slice) appears in create.ts anymore.

Conservative assumptions recorded:
- The child's parent-id field name is derived by convention as `parent_<parent>`
  (slice's existing `parent_prd` field), not a third config field. This keeps the
  one-seam rule and matches the existing template field; a genuinely different
  field name is out of scope until a slice demands it.
- A config-incomplete relationship (child declares parent, but the parent declares
  no child_list) is inert (backlinks nothing) rather than a hard error, so a
  partially-configured tree still creates artifacts. Reversible.
- "slices" stays in create.ts NON_FLAG_FIELDS (unchanged): the child-side list
  field is still CLI-owned, exactly as before.

Tests:
- tests/parent-backlink.test.ts (new — 4 cases): parentBacklink resolves a child's
  parent kind, parent-id field, and child_list field from config under ARBITRARY
  kind names (epic/task, no prd/slice hardcode); a kind with no parent and a parent
  kind both backlink nothing; a child whose parent declares no child_list is inert
  (no throw); and the default prd<->slice relationship is carried as config.
- tests/cli-slice.test.ts (unchanged, still green): the three pinned e2e cases
  (backlink appends without clobbering; create-if-absent when the parent lacks the
  list; optional parent) now exercise the generic config-driven path end-to-end.
- tests/registry-config.test.ts: extended the pinned default-shape assertion to the
  new contract (prd carries child_list: "slices"; added slice.parent === "prd" and
  prd.child_list === "slices" assertions). No test deleted or weakened.

Files changed:
- src/artifacts/registry.ts (parent/child_list fields, parseKinds validation,
  DEFAULT_KINDS, parentBacklink helper)
- src/cli/verbs/create.ts (generic pre-flight + backlinkParent; drop prd/slice
  hardcode)
- wiki.json (declare prd.child_list / slice.parent in the reference config)
- tests/parent-backlink.test.ts (new)
- tests/registry-config.test.ts (pinned shape updated to the new contract)
- .ralph/items.json (SLICE-0114 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 404 pass, 0 fail, 1288 expect() calls, 52 files

Next-iteration notes: SLICE-0115 (relocation preserves identity) is unblocked
(blockers 0111 + 0112 both pass), as is SLICE-0116 (0111 + 0112). Lowest-numbered
next is SLICE-0115: generalize relocateArtifact / doc recategorize
(src/artifacts/store.ts, src/cli/verbs/doc.ts) into a section-agnostic move-to-bucket
(same-section keeps id, cross-section re-mints), migrating store.ts relocation off
DocCategory/isDocCategory.

## SLICE-0115 RELOCATION PRESERVES IDENTITY (PASS)

Selected as the lowest-numbered unfinished item; its blockers SLICE-0111 and
SLICE-0112 are both passes:true.

Decision rationale: generalize the doc-only relocate/recategorize into a
section-agnostic "move to bucket". A same-section move keeps the artifact id
(the section owns the id-space, so inbound [[id]] links stay resolvable); a
cross-section move re-mints the id in the target section's id-space (the settled
rule; this PRD does no link rewriting). Migrate store.ts relocation off
DocCategory/isDocCategory so no dangling doc-category type remains on the move
path for the SLICE-0117 deletion.

Implementation:
- src/artifacts/store.ts: RelocateArtifactInput.category (DocCategory) is replaced
  by `bucket?: string` (a create-name resolved through the structure). relocateArtifact
  now resolves the target via structure.bucketFor(bucket) and branches on section:
  - unknown bucket -> ArtifactValidationError("unknown bucket: <name>").
  - cross-section (resolved.section.name !== input.type) -> re-mint via the shared
    mintAndWrite seam against the TARGET section, rewriting id + aliases on the moved
    frontmatter (remintAliases swaps the old id for the new and guarantees the new id
    is present), passing body/other fields through verbatim, then rm the old file. No
    re-validation (a move repositions, it does not repair), consistent with the
    existing narrowed-write philosophy.
  - same-section move or pure retitle -> id preserved; destination is the resolved
    bucket folder (or the file's current dirname for a pure retitle), re-slugged
    filename, existing duplicate-destination guard kept.
  Dropped the DocCategory/isDocCategory imports and the doc-only existingCategory
  helper + its `relative` import. Added a `projectPath` import (used to build the
  destination under the resolved bucket.folder). artifactDirectory is still used by
  the create/read paths, so its import stays.
- src/cli/verbs/doc.ts: dropped DOC_CATEGORIES/isDocCategory/DocCategory imports.
  recategorizeDoc now passes { bucket: category }; the relocate() helper validates
  the requested category against the loaded doc section's declared bucket names
  (structure.sections.find name==="doc") and emits the same "unknown category" +
  "category must be one of: ..." messages before any move, so the CLI contract
  (exit 1, message contains "category") is preserved while the vocabulary is now
  config-driven rather than the hardcoded DOC_CATEGORIES enum.

Consumers still on the old machinery after this slice: src/artifacts/registry.ts
(owner) and src/bootstrap/doctor.ts no longer import it; the remaining importer of
DOC_CATEGORIES/isDocCategory/defaultCategoryForDocType/DocCategory is registry.ts
itself (the exports), deleted in SLICE-0117. Verified: store.ts and doc.ts now have
zero references; create.ts (0112) and doctor.ts (0113) were already migrated.

Conservative assumptions recorded:
- The doc-only ADR-0028 "refuse to relocate a doc sitting in a non-locked folder
  unless an explicit locked category is given" guard is dropped. It was doc-specific
  and tied to isDocCategory; the no-loose-files / undeclared-folder invariant is now
  enforced structurally by doctor against the config tree (SLICE-0113), so the store
  seam no longer second-guesses the move. A pure retitle keeps the file exactly where
  it is (dirname of the current path), so a doc in any folder retitles in place. This
  is reversible and no existing test depended on the refusal.
- Cross-section re-mint rewrites only id + aliases + title + updated; it does not
  re-validate against the target template (a cross-section move is rare and may cross
  schemas). Matches the existing "move, don't repair" stance.

Tests (tests/relocate-section.test.ts, new -- 4 cases) on a custom wiki.json tree
(branch section `notebook` prefix NOTE with draft/final buckets; leaf section
`archive` prefix ARCH) against a TEMP vault: a same-section draft->final move keeps
NOTE-0001 and the id still resolves via readArtifact; a pure retitle (no bucket)
keeps the file in its current folder with the id preserved; a cross-section
notebook->archive move re-mints to ARCH-0008 (highest archive id + 1), swaps aliases
to the new id, removes the old file, and resolves by the new id; an unknown bucket
throws "unknown bucket". The real $HOME/Knowledge vault is never touched (mkdtemp
temp vaults only).

Pinned tests still green unchanged: tests/cli-doc.test.ts (doc recategorize moves
DOC-0001 architecture<->runbooks keeping its id; unknown category exits 1 with the
category vocabulary) and tests/path-containment.test.ts (relocateArtifact id
traversal guard; create+read+retitle keeps the id) now exercise the generalized
path. No test was deleted or weakened.

Files changed:
- src/artifacts/store.ts (section-agnostic relocate; bucket input; re-mint on
  cross-section; drop DocCategory/isDocCategory + existingCategory)
- src/cli/verbs/doc.ts (recategorize -> bucket; validate against loaded doc section)
- tests/relocate-section.test.ts (new)
- .ralph/items.json (SLICE-0115 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB)
- bunx tsc --noEmit: clean
- bun run test: 408 pass, 0 fail, 1305 expect() calls, 53 files

Next-iteration notes: SLICE-0116 (capture resolves kind via per-vault tree) is
unblocked (blockers 0111 + 0112 both pass) and is the lowest-numbered remaining
item. After this slice store.ts and doc.ts no longer import the doc-category
machinery; only registry.ts's own exports remain, so SLICE-0117 (capstone deletion)
now needs only SLICE-0116's blocker chain plus its own already-passing blockers
(0112/0113/0114/0115) -- but 0116 is lower-numbered and should be taken first.

## SLICE-0116 CAPTURE RESOLVES KIND VIA PER-VAULT TREE (PASS)

Selected as the lowest-numbered unfinished item; its blockers SLICE-0111 and
SLICE-0112 are both passes:true.

Decision rationale: fix the latent coupling in the PRD-0022 capture path so kind
resolution rides the SAME per-vault Structure the write step uses. Today (verified)
src/artifacts/capture.ts imported both DEFAULT_STRUCTURE and loadStructure:
resolveKind read DEFAULT_STRUCTURE.kinds / DEFAULT_STRUCTURE.typeForId while
fileArtifact loaded loadStructure(vaultRoot) for the write. Harmless while every
vault uses the default tree, but under a custom wiki.json a capture of a
custom-kind draft would warn "maps to no registered wiki kind" instead of filing
it, because the default structure has never seen that kind.

Implementation (src/artifacts/capture.ts only):
- resolveKind now takes the loaded Structure as a parameter and checks
  structure.kinds[template] / structure.typeForId(id) against it, not the bundled
  default. Dropped the DEFAULT_STRUCTURE import (loadStructure + the Structure type
  remain).
- captureArtifact now resolves the vault (getVaultRoot) and loads its Structure
  (loadStructure) UP FRONT, immediately after the artifact-shaped check and before
  resolveKind, then threads vaultRoot + structure into both resolveKind and
  fileArtifact. Both loads are wrapped so a vault/config fault becomes a warn (never
  a throw past the seam), preserving the hook's stdout contract.
- fileArtifact no longer loads the vault or structure itself (they are passed in);
  it keeps only project resolution + the mintAndWrite file. The now-dead
  `structure.kinds[kind] === undefined` guard was removed: kind was just resolved
  against this same structure, so it is always present.

Order note: vault + structure resolution now precede the no-kind warning. Under the
test harness (KNOWLEDGE_VAULT_ROOT always set) the vault always resolves, so the
existing warning order is unchanged: the "names no kind" case still warns about the
kind, and the "no resolvable project" case still warns about the project. Verified by
the unchanged tests/cli-hook.test.ts capture suite (8 cases) staying green.

Conservative assumption recorded: "custom bucket" in this slice is exercised as a
custom LEAF section (a kind the default tree does not define). A leaf section is its
own bucket (named after the section, filing into the section folder), so capturing a
custom-kind draft files it into that section's folder with a section-prefixed id via
mintAndWrite. Bucket-subfolder routing on capture (filing into a branch section's
named subfolder) is not in scope here — capture files into the section folder exactly
as it did for the default doc section; this slice only fixes WHICH structure resolves
the kind, matching the item's "regression + coupling fix, no direct user story" framing.

Tests (tests/capture-custom-tree.test.ts, new — 2 cases) against a TEMP vault whose
wiki.json declares a `bug` leaf kind (prefix BUG, folder bugs) the default structure
has never seen: capturing a `template: bug` draft is recognized, filed into bugs/ as
BUG-####-<slug>.md with a BUG-prefixed frontmatter id and the resolved project; a
re-fire on the same (now id-stamped) draft is idempotent (still exactly one file).
The real $HOME/Knowledge vault is never touched (mkdtemp temp vault + a saved/restored
KNOWLEDGE_VAULT_ROOT). Confirmed the test is a real regression guard: it FAILS on the
pre-fix code (custom `bug` kind warns instead of capturing) and PASSES with the fix.
No existing test was deleted or weakened.

Files changed:
- src/artifacts/capture.ts (per-vault structure threaded into resolveKind; vault +
  structure loaded up front; drop DEFAULT_STRUCTURE import; remove dead kind guard)
- tests/capture-custom-tree.test.ts (new)
- .ralph/items.json (SLICE-0116 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean
- bun run test: 410 pass, 0 fail, 1313 expect() calls, 54 files

Next-iteration notes: SLICE-0117 (capstone deletion of DOC_CATEGORIES / isDocCategory
/ defaultCategoryForDocType / DocCategory + the doc `type` enum) is now the lowest
unfinished item. Its blockers 0112/0113/0114/0115 all pass and capture no longer
imports the doc-category machinery, so grep should show only registry.ts (the owner /
exporter) still referencing it. SLICE-0118 remains after 0117.

## SLICE-0117 DELETE DEAD DOC-CATEGORY MACHINERY (PASS)

Selected as the lowest-numbered unfinished item; its blockers 0112/0113/0114/0115
all pass. Pre-flight grep confirmed only registry.ts (the owner/exporter) and two
test COMMENTS still referenced the machinery — every runtime consumer (store.ts,
doctor.ts, create.ts, doc.ts, capture.ts) was already migrated by the earlier
slices, so the deletion had no un-migrated importer to break.

Decision rationale: capstone of PRD-0019's three-vocabularies cleanup. Remove the
hardcoded DOC_CATEGORIES / DocCategory / isDocCategory / defaultCategoryForDocType
from registry.ts and the doc `type` enum from templates/doc.md, so a doc no longer
carries BOTH a `type` field and a `category` folder that can disagree. The
config-declared bucket model (SLICE-0110..0116) supersedes ADR-0028's locked
categories.

Implementation:
- src/artifacts/registry.ts: deleted the DOC_CATEGORIES const, the DocCategory
  type, isDocCategory(), and defaultCategoryForDocType(). Kept the `export {
  buildStructure }` that sat between them. The remaining lone reference is a
  descriptive comment on DEFAULT_BUCKETS noting the buckets reproduce "today's
  locked DOC_CATEGORIES (ADR-0028)" — left as historical provenance, references no
  deleted symbol.
- templates/doc.md: removed the `type: { type: enum, required: true, values:
  [runbook, research, guide, learning, reference] }` schema field and the
  `· {{type}}` fragment from the body header line (now `> {{id}} · {{project}}`).
  A doc has no `type` field at all anymore.
- src/cli/verbs/create.ts: removed the legacy defaultDocBucket() helper (it mapped
  the now-gone doc `type` enum to a bucket). A bare `wiki create doc` with no
  --category now defaults to the `notes` bucket (the catch-all) so it still files
  into a declared bucket, not loose in docs/. Explicit --category still validates
  against the loaded section's bucket names; create-by-bucket-name (SLICE-0112) is
  unchanged.
- src/cli/usage.ts: updated the `wiki create doc` help (dropped the --type flag,
  reworded --category as the bucket subfolder defaulting to notes). No test pins
  this string.
- src/bootstrap/doctor.ts: the CONTEXT.md drift remediation message now says
  `wiki create doc --project <p> --category notes` instead of `--type reference`
  (the bootstrap-doctor-repo-binding test only asserts the message contains "wiki
  create doc", which still holds).

Conservative assumptions recorded:
- A bare `wiki create doc` (no bucket name, no --category) defaults to `notes`.
  Rationale: the old code already routed every unmapped `type` to `notes`, and a
  loose doc in docs/ would now be flagged by doctor (SLICE-0113). `notes` is the
  documented catch-all, a reversible default, and keeps `wiki create doc` working
  without inventing a new fallback.
- `type: research`/`type: runbook` still appearing in tests/artifacts.test.ts
  createArtifact `fields` is now a harmless unknown frontmatter field: validate()
  only checks declared schema fields and render preserves extras, so those path/id
  assertions stay green untouched. Not migrated because nothing asserts on the
  field there.

Tests (no test deleted or weakened; every type-enum assertion was rewritten to the
new contract explicitly):
- tests/cli-doc.test.ts: the basic-create case now asserts the file has NO `type:`
  field. Replaced "derives the category from type" with "no --category defaults to
  the notes bucket". Removed the now-meaningless "routes an unmapped type to notes"
  (the type enum is gone) — folded into the notes-default case. Replaced "exits 1
  when type is missing" with "no longer requires --type and creates with no type
  field" (exit 0, no type field). Replaced "exits 1 for invalid type enum value"
  with "rejects the removed --type flag" (--type is now an unknown flag -> nonzero
  exit). Dropped --type from the tags case (and its `type: research` assertion),
  the unknown-category case, the increments-IDs case, and the createArgs() helper
  (now files via --category runbooks to keep the docs/runbooks/ path assertions).
- Dropped the stale --type arg from tests/cli-create-path-echo.test.ts (->
  --category runbooks), tests/cli-template-bleed.test.ts (-> --category runbooks),
  tests/cli-one-shot-create.test.ts (-> --category research),
  tests/cli-dedup.test.ts (-> --category notes), and the three --type reference
  args in tests/create-by-bucket.test.ts (removed; --category drives the folder).

Verified the new "creates with no type field" assertion is a real deletion guard:
manually created a doc against a TEMP fixture vault (never the real $HOME/Knowledge)
— it filed into docs/notes/DOC-0001-*.md with frontmatter carrying no `type` key and
a clean body header `> DOC-0001 · p` (no literal {{type}}).

Files changed:
- src/artifacts/registry.ts (delete DOC_CATEGORIES/DocCategory/isDocCategory/
  defaultCategoryForDocType)
- templates/doc.md (remove the `type` enum field + `· {{type}}` body fragment)
- src/cli/verbs/create.ts (remove defaultDocBucket; bare doc defaults to notes)
- src/cli/usage.ts (doc create help: drop --type, reword --category)
- src/bootstrap/doctor.ts (drift message: --type reference -> --category notes)
- tests/cli-doc.test.ts, tests/cli-create-path-echo.test.ts,
  tests/cli-template-bleed.test.ts, tests/cli-one-shot-create.test.ts,
  tests/cli-dedup.test.ts, tests/create-by-bucket.test.ts (migrate off --type)
- .ralph/items.json (SLICE-0117 passes false->true)
- .ralph/progress.md (this entry)

ADR-0028 (locked doc categories) is superseded by the config-declared bucket model
introduced across SLICE-0110..0116; doctor's no-loose-files invariant is now
expressed against the per-vault config tree (SLICE-0113) rather than the deleted
DOC_CATEGORIES enum.

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 409 pass, 0 fail, 1310 expect() calls, 54 files

Next-iteration notes: SLICE-0118 (custom tree end-to-end + criteria) is the only
remaining unfinished item; its blockers 0110/0111/0112/0113 all pass. It should
build a TEMP vault with a custom wiki.json (a bugs bucket + an architecture section
with buckets), prove create/doctor/nextId drive entirely from config, surface each
bucket's `criteria` via `wiki create <bucket> --help` and `wiki schema <bucket>`,
and update the wiki skill doc for the create-by-bucket syntax.

## SLICE-0118 CUSTOM TREE END-TO-END + CRITERIA (PASS)

Selected as the only remaining unfinished item; its blockers 0110/0111/0112/0113
all pass.

Decision rationale: prove the section/bucket tree mechanism end-to-end on a TEMP
vault whose wiki.json declares a tree the tool has never seen, and surface each
bucket's `criteria` (the agent's what-goes-where signal) through the CLI. Two
small code gaps blocked a true end-to-end proof and are closed here:
- handleCreate resolved a create-name only against the bundled DEFAULT_STRUCTURE,
  so `wiki create <custom-bucket>` (a bucket declared only in the vault's
  wiki.json) errored "unknown artifact type". It now tries the default tree first
  (preserving the `create bogus`/`create blueprints` contracts that run before any
  vault load), then falls back to the per-vault loaded Structure for a custom kind
  or bucket. A vault-load fault (unconfigured) keeps the default-kinds error; a
  malformed wiki.json still throws loudly.
- `wiki create <bucket> --help` and `wiki schema <bucket>` only knew section kinds,
  so a bucket's criteria was unreachable from the CLI.

Implementation:
- src/cli/verbs/create.ts: handleCreate gained a per-vault fallback (tryLoadStructure
  -> structure.kinds / structure.bucketFor) after the synchronous default-tree
  resolve; extracted presetFor() (branch bucket -> subfolder, leaf -> none) shared by
  both resolve paths. tryLoadStructure returns undefined when no vault is configured
  (getVaultRoot throws) so the unconfigured `create bogus` contract still lists the
  bundled kinds. Added renderBucketCreateHelp(name): loads the structure (default
  fallback), resolves the bucket, and renders help showing the section prefix, the
  config-declared folder, and the bucket's `criteria`. Returns null for a non-bucket
  so dispatch falls back to generic help.
- src/cli/dispatch.ts: the per-verb help branch, when the create subverb names no
  curated USAGE entry, now calls renderBucketCreateHelp and prints it if the name
  resolves to a bucket (else falls through to generic create help). Imported the
  helper.
- src/cli/verbs/schema.ts: rewrote handleSchema to resolve the positional via a new
  resolveSchemaTarget(structure, name) that accepts a kind OR a bucket/leaf name. A
  bucket resolves to its section's template and carries the bucket's `criteria`,
  printed after the field list (human) and added to the JSON object. The usage line
  now lists kinds + branch-bucket names. The existing `wiki schema slice` (kind,
  --json) contract is unchanged (a kind has no criteria).
- src/cli/usage.ts: schema entry updated to `wiki schema <kind|bucket>` and notes a
  bucket prints its criteria.
- skills/wiki/SKILL.md: replaced the locked-category guidance with the create-by-bucket
  syntax — `wiki create <bucket>` files into the bucket subfolder, `wiki create
  <bucket> --help` / `wiki schema <bucket>` show criteria, buckets are config-declared
  in wiki.json (not a hardcoded lock); doctor flags undeclared folders / loose files.

Conservative assumptions recorded:
- Per-bucket template OVERRIDE on the create path stays out of scope (as in SLICE-0112):
  the create path still loads the template by SECTION name, and the custom-tree test
  reuses the bundled `doc` / `decision` templates by reshaping those sections' folders,
  prefixes (DOC/ADR, matching the templates' id patterns), and buckets entirely from
  config. The slice's "drives templates from config" is exercised by config-declared
  section->template selection, which is what the bucket model already provides; a
  genuinely new template body for a never-before-seen kind would need a templates/<kind>.md
  and is not required to prove the tree mechanism. The "architecture section" is modeled
  as the decision section relocated to folder architecture/ with components/boundaries
  buckets, proving a top-level non-default section with its own buckets and id-space.
- A malformed wiki.json on the create fallback path throws (a present-but-broken config
  is a real error); only an unconfigured vault falls back to the bundled-kinds error.

Tests (tests/custom-tree-e2e.test.ts, new — 5 cases) against a TEMP vault whose
wiki.json declares a custom tree (doc reshaped to a knowledge/ branch with a `bugs`
bucket the default tree never had; decision reshaped to a top-level architecture/
branch with components/boundaries buckets): creating into custom buckets files into
the config-declared folders with section-prefixed ids minted per-section (DOC-0001
bug, DOC-0002 runbook sharing the doc id-space; ADR-0001 component from the separate
architecture id-space); doctor passes structural validation against the custom tree
and nextId honors each section's independent id-space (DOC-0002 / ADR-0002); an
undeclared folder under a custom branch section is flagged; `wiki create bugs --help`
surfaces the bucket criteria + folder + prefix from the loaded structure; `wiki schema
components` lists the decision-template fields and prints the bucket criteria (human +
--json). The real $HOME/Knowledge vault is never touched (mkdtemp temp vaults only).
No existing test was deleted or weakened.

Files changed:
- src/cli/verbs/create.ts (per-vault create-name fallback; renderBucketCreateHelp)
- src/cli/dispatch.ts (intercept create-by-bucket --help)
- src/cli/verbs/schema.ts (resolve kind OR bucket; surface criteria)
- src/cli/usage.ts (schema entry: kind|bucket + criteria)
- skills/wiki/SKILL.md (create-by-bucket syntax; criteria via help/schema)
- tests/custom-tree-e2e.test.ts (new)
- .ralph/items.json (SLICE-0118 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 414 pass, 0 fail, 1334 expect() calls, 55 files

This is the last item in the bundle. PRD-0018 (0108-0109) and PRD-0019 (0110-0118)
are complete: all 11 items pass with the full gate green at each commit.
