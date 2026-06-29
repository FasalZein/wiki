# PRD-0023 progress

## SLICE-0119 RESEARCH BECOMES A VAULT KIND (PASS)

Selected as the lowest-numbered unfinished item; it has no blockers and starts
PRD-0023.

Decision rationale: research already files into the bundled `doc` branch
section's `research` bucket (docs/research/, DOC id-space) via the config-driven
tree from PRD-0019. The separate `research` qmd collection, its `research_path`
config, and the `--include-research` flag were a parallel store with no remaining
purpose (G2 collision + G9 dead knob, ADR-0039). Removed them so research is an
ordinary vault artifact returned by plain `wiki search`.

Implementation:
- src/cli/verbs/search.ts: dropped the `include-research` boolean flag and the
  whole research-collection branch (the uniformConfigValue/divergence check on
  research_path, the registered.has("research") push, the never-synced skip).
  uniformConfigValue/divergenceMessage stay — still used for the qmd_command
  single-binary check. Updated the two stale "research path" comments.
- src/cli/verbs/sync.ts: dropped the `include-research` flag and the research
  target push; sync now only ever targets the project's own collection.
  booleanValue is still used (pull/force-embed).
- src/config/project.ts: removed the `research_path` field from ProjectConfig and
  its loader line; dropped the now-unused `expandHome` import (it was used only
  for research_path).
- src/integrations/qmd.ts: removed the stale research_path resolution comment from
  the module header.
- src/cli/usage.ts: removed `--include-research` from the `wiki search` and
  `wiki sync` usage strings and flag tables.
- README.md: deleted the dead `[research] sources` TOML example from the config
  block. (The "Docs are nested by locked category" line is left for SLICE-0124,
  which owns the README docs-category text; this item owns only the [research]
  block per the plan.)

Conservative assumption recorded: a now-removed flag (`--include-research`) is
rejected by strict parseArgs as an unknown option, which the CLI surfaces as a
ParseError (exit 1). The rewritten tests pin that exit-1 contract rather than
silently dropping the cases.

Tests (no test deleted or weakened; the two flag-exercising cases were rewritten
to the new contract explicitly):
- tests/cli-search.test.ts: replaced "search include-research queries both
  pre-synced collections" with "search rejects the removed --include-research
  flag" (exit 1, no `--collection research` touched). Removed the unused
  researchPath fixture field, its mkdir, and the research_path frontmatter line.
- tests/cli-sync.test.ts: replaced "sync include-research also refreshes the
  research collection" with "sync rejects the removed --include-research flag"
  (exit 1, no `--name research`). Removed the researchPath fixture plumbing.
- tests/search-upgrade.test.ts: removed the researchPath fixture field, its mkdir,
  and the research_path frontmatter lines (no test there exercised the flag; pure
  fixture noise now that the config field is gone).

Step 4 (research files into docs/research/) is already proven by the existing
tests/create-by-bucket.test.ts case (`--category research` -> docs/research/ with
a DOC-0001 id and the doc template) and tests/cli-one-shot-create.test.ts; no new
test needed.

Files changed:
- src/cli/verbs/search.ts (drop include-research branch + flag)
- src/cli/verbs/sync.ts (drop include-research flag + research target)
- src/config/project.ts (remove research_path field + loader + expandHome import)
- src/integrations/qmd.ts (remove research_path header comment)
- src/cli/usage.ts (remove --include-research from search/sync)
- README.md (delete [research] sources example)
- tests/cli-search.test.ts, tests/cli-sync.test.ts, tests/search-upgrade.test.ts
  (rewrite flag cases to the rejection contract; drop research fixture plumbing)
- .ralph/items.json (SLICE-0119 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, bundled 99 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 415 pass, 0 fail, 1333 expect() calls, 55 files

Next-iteration notes: SLICE-0120 (capture honest on frontmatter) is the next
lowest unfinished item and has no blockers. SLICE-0121 (allocation lock) and
SLICE-0122/0123/0124 are also unblocked; pick the lowest-numbered false item.

## SLICE-0120 CAPTURE IS HONEST ON FRONTMATTER (PASS)

Selected as the lowest-numbered unfinished item; no blockers.

Decision rationale: the warn/captured/null/idempotent behavior already lives in
src/artifacts/capture.ts (built across SLICE-0116). resolveKind returns null only
when neither template nor id maps to a registered kind, and captureArtifact then
returns the 'no registered wiki kind' WARN outcome (not null, not a wrong-kind
write). A bare draft with no id/template returns null (silent). So this item's
real deliverable per the plan was pinning that contract with tests — in
particular a regression guard that fails if capture ever regresses to returning
null on an id/template-bearing draft whose kind is unregistered. No source change
was needed; capture.ts already satisfies every step.

Implementation:
- tests/capture-frontmatter-contract.test.ts (new): four branches on a TEMP vault
  with a custom single-`bug`-kind wiki.json —
  1. template:bug resolvable -> captured + filed under bugs/.
  2. template:epic and id:EPIC-0001 (neither registered) -> WARN, message
     contains 'no registered wiki kind'. This is the regression guard: it asserts
     the outcome is not null and is 'warn'.
  3. a draft with only title (no id/template) -> null (silent); the test comment
     documents why a bare draft cannot warn (capture sees every write via the
     unfiltered hook path).
  4. re-fire on an id-stamped draft -> captured both times, filed once
     (idempotent).

No source files changed (capture.ts already correct); no existing test weakened
or deleted.

Conservative assumption recorded: capture's existing message text 'maps to no
registered wiki kind' is treated as the stable contract phrase; the test asserts
the substring 'no registered wiki kind' so a future reword that keeps the meaning
still passes while a regression to null fails.

Files changed:
- tests/capture-frontmatter-contract.test.ts (new contract test)
- .ralph/items.json (SLICE-0120 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, 99 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 419 pass, 0 fail, 1344 expect() calls, 56 files

Next-iteration notes: SLICE-0121 (per-project allocation lock, no blockers) is the
next lowest unfinished item. Its shared-seam rule puts the lock INSIDE mintAndWrite
in src/artifacts/store.ts. SLICE-0122/0123/0124 are also unblocked; pick the lowest
false item.
