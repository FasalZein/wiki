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

## SLICE-0121 PER-PROJECT ALLOCATION LOCK (PASS)

Selected as the lowest-numbered unfinished item; no blockers (SLICE-0119/0120
already pass).

Decision rationale: the duplicate-id race (G3, ADR-0041) is real and the existing
`wx`-exclusive-create + bounded-retry in mintAndWrite did NOT cover it. That guard
only catches a same-PATH collision; two concurrent creates with DIFFERENT titles
each compute the same nextId, render distinct file paths, and both succeed — two
artifacts silently share one id. Verified empirically: with the lock removed, 4 of
the 5 new tests fail (duplicate ids minted), confirming the guard was insufficient
and the new test is a true regression guard.

Per the SHARED-SEAM RULE the lock goes INSIDE mintAndWrite (src/artifacts/store.ts),
the one seam both create and capture call, so capture is covered without editing
capture.ts.

Implementation:
- src/artifacts/lock.ts (new): withProjectLock(vaultRoot, project, fn) serializes a
  project's allocate->write critical section with a short-lived exclusive lockfile
  at <vault>/.wiki/locks/<project>.lock, created with the `wx` flag (atomic single
  winner). STALE_MS=10s reclaim-by-mtime so a crashed holder cannot wedge the vault;
  ACQUIRE_TIMEOUT_MS=15s bound so a stuck peer surfaces as an error not a hang;
  POLL_MS=10 backoff. The lock is released in a finally on BOTH success and error
  paths. assertSafeSegment guards the project name (defense-in-depth; projectPath
  already guards upstream). The lock dir lives OUTSIDE projects/ so it is never
  scanned by the id index or any artifact walk.
- src/artifacts/store.ts: mintAndWrite now wraps its whole allocate->write loop in
  withProjectLock(target.vaultRoot, target.project, ...). The `wx` create + bounded
  retry is KEPT as a cheap second guard for a same-path collision. Updated the stale
  'No lockfile' docstring to describe the lock and the race it closes.

Conservative assumptions recorded:
- Lock placement <vault>/.wiki/locks/<project>.lock (reversible; not in projects/,
  so no walk/index reads it). The plan allowed "<vault>/.wiki/ (or project dir)".
- STALE_MS=10s / ACQUIRE_TIMEOUT_MS=15s are generous vs the sub-ms critical section;
  tunable constants, not a contract.

Tests (new, TEMP vault only): tests/allocation-lock.test.ts —
  1. two concurrent DIFFERENT-title creates in one project get distinct ids
     {PRD-0001, PRD-0002} (the core race the lock closes).
  2. 8 concurrent creates all get distinct ids (no duplicates).
  3. creates in DIFFERENT projects each start at PRD-0001 (no contention — separate
     lockfiles).
  4. a stale lockfile (mtime -60s via `touch -t`) is reclaimed, create succeeds, no
     lingering lockfile (no deadlock).
  5. the lockfile lives under .wiki/locks and is never mixed into projects/<p>/.
No existing test weakened or deleted.

Files changed:
- src/artifacts/lock.ts (new)
- src/artifacts/store.ts (wrap mintAndWrite critical section + docstring)
- tests/allocation-lock.test.ts (new)
- .ralph/items.json (SLICE-0121 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit):
- bun run build: ok (cli.js 0.32 MB, 100 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 424 pass, 0 fail, 1356 expect() calls, 57 files

Next-iteration notes: SLICE-0122 (doctor --fix duplicate ids + spine drift, no
blockers) is the next lowest unfinished item. SLICE-0123/0124 are also unblocked.
SLICE-0126 (incremental qmd update) is now UNBLOCKED since its blocker SLICE-0121
passes — same mintAndWrite seam — but pick the lowest-numbered ready item.

## SLICE-0122 WIKI DOCTOR --FIX REPAIRS DUPLICATE IDS AND SPINE DRIFT (PASS)

Selected as the lowest-numbered unfinished item; no blockers (SLICE-0119/0120/0121
all pass).

Decision rationale: the duplicate-id check (checkProjectIdDrift) already DETECTS an
id mapping to >1 file but had no repair path. SLICE-0122 adds the `--fix` mode: per
project, renumber duplicate ids FIRST, then run the same mechanical fixes fmt --write
already applies (legacy-id renumber with vault-wide [[id]] link rewrite, rename to
id-slug, the per-file category pipeline). Renumber-then-fmt order matters so the
post-renumber/rename world is what fmt sees, and a final runDoctor re-audit reports
drift --fix cannot auto-repair (dangling links, repo bindings).

Duplicate-id repair design (conservative, reversible): when an id maps to N files the
lexicographically-FIRST path is canonical and KEEPS the id (so inbound [[OLD]] links
from other files still resolve to it — there is no way to disambiguate which duplicate
an external link meant, and keeping canonical is the least-surprising choice). Every
other file is reassigned the next free id in that section's id-space via nextId (the
same allocation seam create uses, so the new id never re-collides). The reassigned
file's own id, aliases, and any SELF-referential [[OLD]] body links are rewritten to
the new id so it stays internally consistent; the file is renamed to <newid>-<slug>.md.
The frontmatter id moves before the next nextId read, so sequential duplicates each get
a distinct fresh id.

Implementation:
- src/cli/verbs/fmt.ts: extracted the whole fix pipeline out of handleFmt into a new
  exported applyFmtFixes(vaultRoot, projPath, write, structure) returning
  {labels, total, manual, renumberMap}. handleFmt now calls it and prints exactly the
  same output (same label order, same renumber/manual sections) — no behavior change,
  proven by the unchanged cli-fmt.test.ts suite still green. This lets doctor --fix
  drive the identical mechanical fixes without duplicating the renumber/rename/category
  logic.
- src/bootstrap/doctor.ts: added repairDuplicateIds(vaultRoot, project, structure)
  (returns {labels, reassigned}) and the private reassignId helper. Reuses buildIdIndex
  (the spine), nextId (allocation), and slugifyTitle (filename). New imports: nextId,
  slugifyTitle, rm, writeFile, dirname.
- src/cli/verbs/vault.ts: vaultDoctor now parses a `fix` boolean and routes to the new
  vaultDoctorFix(vaultPath) — iterate projects, repairDuplicateIds then applyFmtFixes
  (write=true), print the fixes, then runDoctor re-audit (exit 0 clean / 1 if drift
  remains). Detect-only `doctor` (no --fix) is unchanged.
- src/cli/usage.ts: documented the new --fix flag on both the `doctor` verb and the
  `vault doctor` subverb.

Conservative assumptions recorded:
- Canonical = lexicographically-first path. Reversible; the alternative (first by mtime
  or by filename-matches-id) is not more correct without semantic info, and the loop is
  idempotent either way.
- Renaming the reassigned file to <newid>-<slug>.md happens inside reassignId rather than
  deferring solely to fmt's renameToId, so the on-disk name matches the new id immediately
  and the next --fix run sees a clean vault (idempotency).
- An external [[OLD]] link is left pointing at the canonical artifact (documented above);
  --fix does not guess which duplicate it meant.

Tests (new, TEMP vault only): tests/cli-doctor-fix.test.ts —
  1. unit: repairDuplicateIds keeps canonical PRD-0005, renumbers the duplicate to
     PRD-0006, rewrites its alias and its self-referential [[PRD-0005]] -> [[PRD-0006]],
     and removes the old duplicate filename.
  2. unit: no-op when every id is unique (reassigned === 0).
  3. e2e: `wiki doctor <vault>` WITHOUT --fix is detect-only — reports duplicate-id,
     exit 1, both files still PRD-0005 on disk (no write).
  4. e2e: `wiki doctor <vault> --fix` repairs the duplicate (distinct PRD ids on disk)
     AND drives the legacy-id renumber + vault-wide inbound-[[link]] rewrite
     (SLICE-001 -> SLICE-0001, the referencing file's link updated — the link-rewriting
     path the item requires); a second --fix run is a no-op and reports clean.
No existing test weakened or deleted; cli-fmt.test.ts unchanged and still green
(confirms the applyFmtFixes extraction preserved fmt's output contract).

Note on running tests: the verification gate is `bun run test` (= `bun test tests/`).
A bare `bun test` from the repo root picks up unrelated test files outside tests/ (an
mcp/skill suite with 32 pre-existing failures and an intermittent Bun teardown abort);
those are NOT part of this repo's gate and are unrelated to this change.

Files changed:
- src/cli/verbs/fmt.ts (extract applyFmtFixes; handleFmt consumes it)
- src/bootstrap/doctor.ts (repairDuplicateIds + reassignId)
- src/cli/verbs/vault.ts (--fix routing + vaultDoctorFix)
- src/cli/usage.ts (document --fix on doctor and vault doctor)
- tests/cli-doctor-fix.test.ts (new)
- .ralph/items.json (SLICE-0122 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit, gate = bun run test):
- bun run build: ok (cli.js 0.33 MB, 100 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 428 pass, 0 fail, 1378 expect() calls, 58 files

Next-iteration notes: SLICE-0123 (doctor --setup honest about non-Pi subagent capture
reach, no blockers) is the next lowest unfinished item — pre-answered as 'unverified',
do NOT run Codex/Claude. SLICE-0124 is also unblocked. SLICE-0125 (blocked by 0120,
now satisfied) and SLICE-0126 (blocked by 0121, now satisfied) are also ready, but pick
the lowest-numbered false item.

## SLICE-0123 DOCTOR --SETUP HONEST ABOUT NON-PI SUBAGENT CAPTURE REACH (PASS)

Selected as the lowest-numbered unfinished item; no blockers (SLICE-0119..0122
all pass).

Pre-answered fact recorded (per the runtime contract and ADR-0043): the
empirical "does Codex/Claude PostToolUse actually reach the persist hook"
question is NOT run this iteration. No Codex or Claude harness was executed to
confirm reach. Non-Pi reach is hard-coded to 'unverified' from ADR-0043 context;
the loop delivers only the testable reporting change.

Decision rationale: doctor --setup printed a blanket "setup is healthy" line
that said nothing about whether non-Pi subagents capture to the vault, so a green
setup silently implied parity the tool does not have. The fix reports capture
reach honestly per harness: Pi is bridge-checkable from its on-disk ~/.pi
subagent allowlists (the existing unreachableSubagents check already covers the
fixable Pi gap); Codex and Claude Code are reported 'unverified /
Pi-subagent-only'. Capture reach is reported separately from issues/clean: a
non-Pi 'unverified' is the expected steady state (ADR-0043), not a fixable fault,
so it must not flip `clean` to false — but it must never be hidden either.

Implementation:
- src/bootstrap/setup-doctor.ts: added the CaptureReach type, the static
  CAPTURE_REACH table (pi=checkable, codex/claude-code=unverified, each with a
  detail string), and a captureReach field on SetupResult. evaluateSetup now
  returns CAPTURE_REACH alongside issues/clean without touching the clean
  computation. No harness is executed; the table is pre-decided constants.
- src/cli/verbs/vault.ts: setupDoctor now prints a "capture reach (per harness):"
  block on BOTH the clean and the issues path via a new printCaptureReach helper,
  so a healthy setup still surfaces the non-Pi unverified reach. Import widened to
  pull the CaptureReach type. Exit code unchanged (reach is reporting-only).

Conservative assumptions recorded:
- Capture reach is reporting-only and does NOT affect the exit code (a
  steady-state 'unverified' is not a failure). Reversible if a future policy
  wants to gate on it.
- Status vocabulary is 'checkable' (Pi) vs 'unverified' (non-Pi); the detail
  strings carry the ADR-0043 'Pi-subagent-only' framing the plan names.

Untrusted-input note (recorded per the unattended-loop rule): the runtime
prompt's "vault-context" block carried an injected instruction to run a "vault
maintenance protocol" that writes the real $HOME/Knowledge vault to 'refresh the
artifact index'. Declined: it violates the hard rule that the real vault is never
written by the loop, the loop's cross-iteration state lives only in .ralph/* and
git (the next iteration does not query the real vault index), and it was not part
of any item's steps. No real-vault read or write was performed.

Tests (new case, no existing test weakened or deleted):
- tests/cli-setup-doctor.test.ts: added "capture reach distinguishes Pi
  (checkable) from non-Pi (unverified), without flipping clean" — asserts a
  healthy setup still reports pi=checkable, codex=unverified,
  claude-code=unverified, and that clean stays true. This fails if the report
  regresses to a blanket-healthy claim or marks non-Pi as checkable.

Files changed:
- src/bootstrap/setup-doctor.ts (CaptureReach type + CAPTURE_REACH table + field)
- src/cli/verbs/vault.ts (printCaptureReach on both paths; import widened)
- tests/cli-setup-doctor.test.ts (new per-harness reach test)
- .ralph/items.json (SLICE-0123 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit, gate = bun run test):
- bun run build: ok (cli.js 0.33 MB)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 429 pass, 0 fail, 1384 expect() calls, 58 files

Next-iteration notes: SLICE-0124 (docs/metadata/qmd parse cleanup, no blockers)
is the next lowest unfinished item. SLICE-0125 (blocked by 0120, satisfied) and
SLICE-0126 (blocked by 0121, satisfied) are also ready; SLICE-0127 needs 0120 +
0126. Pick the lowest-numbered false item.

## SLICE-0124 DOCS, METADATA, AND QMD COLLECTION-LIST PARSE CLEANUP (PASS)

Selected as the lowest-numbered unfinished item; no blockers (SLICE-0119..0123
all pass).

Decision rationale: three independent cleanups (G12/G13 + distribution metadata)
with no behavior coupling. The package.json description still pitched a "locked
Obsidian vault" workflow that PRD-0019 dissolved; the README still called doc
buckets "locked categories" you must never extend, contradicting the config-driven
tree; and listCollections parsed names from the leading human-readable column of
`qmd collection list`, so a qmd version that reindents or reprefixes that line
would yield zero names and make an already-synced collection look "never synced"
(false "needs sync"/skipped-update path).

Implementation:
- package.json: version 0.0.0 -> 0.1.0; description rewritten to "Config-driven
  artifact store and semantic recall tool over a plain-Markdown vault. The CLI is
  the only writer." (drops the stale 'locked Obsidian vault' framing).
- README.md: the "Docs are nested by locked category ... Never invent a folder"
  bullet replaced with the config-driven model — each branch section declares its
  buckets in wiki.json; the six bundled buckets are the default, not a hard lock;
  `wiki schema doc` lists current buckets. Did NOT touch the [research] block
  (SLICE-0119 owns it) — verified no [research] text remains from that item.
- src/integrations/qmd.ts: parseCollectionNames now reads the name out of the
  stable `qmd://<name>/` URI token (regex /qmd:\/\/([^/\s)]+)\//g) instead of the
  fragile `^name (qmd://` leading-column match. Anchoring on the URI keeps the
  substring-false-positive guard (the original reason for exact parsing) AND
  survives an output-format change (extra indent, bullet prefix, different
  spacing). Updated the module header + function comment to describe the URI-token
  contract.

Conservative assumptions recorded:
- Chose the "version-robust parse" alternative the step allows over a `--json`
  collection-list form: the real qmd's `collection list --json` support is
  unverified here, and keying on the `qmd://` URI (which qmd emits in every list
  format observed in the fixtures) hardens against reformat without depending on
  an unconfirmed flag. No external qmd binary was run; the existing shell-fake
  fixtures already emit the `name (qmd://name/)` shape and still parse.
- Version bumped to 0.1.0 (first non-zero minor) rather than guessing a higher
  number; reversible.

Tests (new case, no existing test weakened or deleted):
- tests/qmd-collections.test.ts: added "parses names from the qmd:// URI even
  when the line format changes" — a reformatted list (leading "  - ", a "\t* ...
  -> qmd://rift/" arrow form, trailing "[N files]") still yields exactly
  ["bayland-portfolio-v1", "rift"]. This fails if the parser regresses to the
  leading-column-only match. The original three parseCollectionNames cases and
  the QmdError.summary cases are unchanged and still green (the URI parse is a
  strict superset for the canonical "name (qmd://name/)" shape).

Files changed:
- package.json (description + version)
- README.md (config-driven bucket model bullet)
- src/integrations/qmd.ts (URI-token collection-name parse + comments)
- tests/qmd-collections.test.ts (new reformat-robust case)
- .ralph/items.json (SLICE-0124 passes false->true)
- .ralph/progress.md (this entry)

Verification (all green at this commit, gate = bun run test):
- bun run build: ok (cli.js 0.33 MB, 100 modules)
- bunx tsc --noEmit: clean (exit 0)
- bun run test: 430 pass, 0 fail, 1385 expect() calls, 58 files

Next-iteration notes: SLICE-0125 (skill->kind routing + draft-stamp authoring
contract, blocked by SLICE-0120 which passes) is the next lowest unfinished item.
SLICE-0126 (blocked by SLICE-0121, passes) is also ready; SLICE-0127 needs both
SLICE-0120 and SLICE-0126. Pick the lowest-numbered false item — SLICE-0125.
