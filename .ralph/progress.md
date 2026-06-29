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
