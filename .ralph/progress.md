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
