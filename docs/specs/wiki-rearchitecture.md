# Wiki rearchitecture

Status: Draft for delivery approval. Product choices below are confirmed unless marked open.
Date: 2026-10-05.

## Problem

The existing wiki stores documents without recording which evidence supports their current contents.
Document updates, source changes, and completed work do not reliably change what agents retrieve.
The index also misses some deletions and edits because its freshness mechanism uses modification times.

The replacement is a general knowledge system for Pi and Obsidian.
It must cover code, agent findings, decisions, web research, personal notes, and imported documents.
GitHub owns delivery status. Pi retains session transcripts. The wiki stores distilled knowledge and its sources.

## Confirmed direction

- Keep Markdown authoritative and directly editable in Obsidian.
- Keep evidence in a Git-tracked log under `.wiki`, separate from note frontmatter.
- Build new packages in this repository. Preserve the installed legacy CLI until an approved cutover.
- Use a shared Node-compatible core, with standalone CLI and Pi extension interfaces.
- Use Pi's package structure and public APIs as the architectural reference.
- Design in Pi Durable for background maintenance. Validate its integration before adoption.
- Use qmd hybrid search through a replaceable interface.
- Store full extracted web text locally with its URL, retrieval time, and content digest.
- Compare code evidence against a configured committed local branch. Show the resolved commit.
- Return relevant uncertain knowledge with explicit status. Do not silently hide it.
- Capture distilled findings, procedures, architecture, and decision proposals, not session dumps.
- Stage changes initially. Automatic derived updates remain a later, safety-gated capability.
- Require review for changes to decisions, policies, or personal notes.
- Pilot this repository's knowledge before expanding across projects.

## User stories

1. As an agent, I retrieve relevant knowledge with its evidence status and source references.
2. As an agent, I distinguish source changes from demonstrated contradictions.
3. As an owner, I edit Markdown in Obsidian without an agent silently replacing my edits.
4. As an owner, I retain personal ideas without pretending that an external source proves them.
5. As an agent, I capture reusable session findings without importing transcripts or duplicating task status.
6. As a researcher, I retain the source text that supported a finding, even when the website later changes.
7. As an owner, I import documents with their originals, extraction provenance, and searchable content.
8. As an agent, I propose decision changes without accepting or superseding decisions myself.
9. As an owner, I inspect and merge staged repairs before enabling automatic publication.
10. As a script author, I use the CLI without starting Pi or an always-running service.
11. As a Pi user, I use the same operations through normal tools and Code Mode.
12. As an owner, I resume maintenance without duplicating proposals or concealing uncertain model costs.
13. As an owner, I classify old projects from activity evidence instead of an arbitrary inactivity threshold.
14. As an owner, I import and clean a pilot without modifying the historical archive.

## Domain terms

| Term | Meaning |
| --- | --- |
| Note | Markdown knowledge with a stable identity. |
| Source snapshot | The retained source content used by a check. |
| Digest | A content identifier computed from file contents. |
| Check | A recorded assessment of identified note and source snapshots. |
| Candidate | Distilled content that is not yet maintained knowledge. |
| Staged change | A proposed revision stored separately from its target. |
| Proposal | A change that requires owner review. |
| Evidence log | Persistent records of checks, provenance, reviews, and published results. |
| Maintenance run | Background work that produces checks or staged changes. |

Authority belongs to the note's meaning, not its file extension.
Intent notes contain decisions and policies. Derived notes describe cited evidence.
Personal notes contain owner-authored ideas. Records preserve dated observations or source material.

## Package architecture

```text
wiki-core: knowledge, sources, evidence, staging, review, qmd integration
    ^                 ^                     ^
wiki-cli           pi-wiki             maintenance runner
standalone         Pi extension        Pi Durable + pi-ai
```

The core has no Pi dependency. It exposes typed operations with explicit inputs and results.
The CLI and extension call those operations directly. Neither requires a background service for reads.
Pi extension dependencies follow Pi's peer-dependency contract.
The maintenance runner pins its experimental runtime dependencies and isolates their integration.

The core does not contain a second task queue, scheduler, or retry engine.
Pi Durable owns background task progress and recovery.
Core operations support request identity and repeat-safe effects where their contract requires them.
A request key does not prove that a remote model call executed once.

Do not copy Pi's server, client, protocol, or agent-loop infrastructure without a demonstrated need.
Do not introduce a general extension framework inside the wiki.
Do not adopt scriptc without measured improvement on a real workload.

## Authoritative and operational state

Markdown, original attachments, captured source text, evidence, proposals, and staged changes are authoritative retained data.
They remain usable without Pi Durable's database.
Content storage can deduplicate identical bytes, but it must retain distinct source observations and provenance.

Search indexes and caches are derived. They can be rebuilt from retained knowledge.
Durable storage owns operational progress. It is not another knowledge database.
Its loss during a run can leave an external effect uncertain. Recovery must preserve that uncertainty.
Core result records contain durable evidence of completed operations, not a duplicate scheduling journal.

Evidence records carry a schema version. Durable tasks carry their own version and migration rules.
Unsupported versions or damaged relevant evidence must not produce a positive trust result.

## Evidence contract

A check binds to the exact note and source snapshots that the checker reviewed.
Resolve a repository reference once per repository, then read every source from that immutable commit.
Report the local reference and commit. Do not imply that a remote fetch occurred.

Web checks refer to retained snapshots and retrieval dates. Ordinary reads do not fetch websites.
Imported documents retain originals and extraction provenance. Referenced notes carry their own snapshot identity.
An unavailable repository differs from a file missing in a valid commit.

No check means unchecked. A source link alone never establishes an attestation.
Changed source content means that a note needs review, not that its claim is false.
Changed note content invalidates checks of its previous contents, regardless of modification time.
Personal notes remain owner-authored without external evidence.

Every check has a request identity separate from the content digests.
Repeating the same request is a no-op. A distinct review of identical content is new evidence.
Malformed or incomplete relevant evidence cannot silently revive an older positive result.
An asserted human checker is provenance, not authenticated identity or proof of approval.

Every returned body or excerpt carries the identity of the content its status describes.
Results distinguish unchecked, changed, contradicted, unavailable, attested, owner-authored, historical, and superseded material.
Attestation states who checked what and when. It never means that the note is universally true.

## Retrieval contract

qmd supplies hybrid retrieval. The core owns document identity, freshness reporting, and displayed evidence status.
The pilot must use isolated search storage and must not alter the archive's existing collections.
Index coverage records advance only after successful indexing.
Additions, edits, old-mtime edits, deletions, renames, and failed updates remain detectable.

An old indexed excerpt cannot inherit the current note's evidence status.
Render a current excerpt or explicitly identify the older content.
If the index misses current files, report the incomplete coverage with the results.
Source or provider text remains untrusted content, not instructions to the agent.

## Capture and publication

Explicit CLI and Pi operations capture candidates with source references and session pointers where applicable.
Session harvesting extracts reusable knowledge. It does not copy entire conversations into maintained notes.
Capture and maintenance must search for related notes before proposing duplicates.
Original attachments and full extracted web text remain available for later evidence checks.
Unsupported extraction must be explicit. Do not invent contents for an unreadable document.

Initial maintenance stores proposed updates separately and leaves existing Markdown untouched.
An owner can inspect and merge a staged change through the agreed review workflow.
Recording a review binds to the exact reviewed revision, not a later version sampled at recording time.
Agent interfaces cannot approve intent changes, including acceptance, summary changes, rejection, or supersession.

A CLI lock coordinates cooperating writers only. It does not coordinate Obsidian, Git, or other editors.
Atomic rename is not conditional replacement against these writers.
Automatic publication requires a separate approved safety contract and tests of supported editor behavior.
The initial release makes no automatic in-place publication guarantee.

Pi's direct-write guard is a workflow aid, not a filesystem sandbox.
Shell commands and other writers can bypass it. Do not describe tool hints as security enforcement.

## Durable maintenance and models

The runner uses Pi Durable tasks for work that must survive interruption.
Task checkpoints refer to core-owned inputs and staged results by identity.
One process owns each runtime store. Ordinary CLI and Pi reads do not open another process's Durable store.
Starting the runner is explicit initially. This specification sets no background schedule.

Before adoption, demonstrate recovery, task-version handling, exclusive ownership, cancellation, and classifier-result persistence with fake providers.
Use real core operations and real runtime storage in those tests.
Fakes replace external providers, not implementation.

CLEF uses Pi's existing classifier interface. It assesses supplied evidence and returns probabilities.
It does not retrieve sources, certify truth, or write repairs.
A selected generative model drafts changes. DeepSeek is a candidate, not an approved model choice.

Classifier results include the input snapshot, model, question identity, outcome, and reported usage.
Do not assume that Durable's built-in usage totals include classifier calls.
A persisted request key before a call does not prove that a response or charge exists.
After interruption without a recorded result, report an uncertain effect and spending state.
Do not retry such a paid operation silently.

No hosted inference is authorized by this draft.
Provider, credentials, data-sharing scope, spending, and retry policy require owner approval before live evaluation.
Evaluate real pilot failures against deterministic checks and a generative baseline.
Set adoption criteria from the owner's requirements and measured evidence, not invented sample sizes or probability thresholds.

## Project lifecycle and migration

Show source activity, note activity, and declared project state separately.
Exclude Pi checkpoint refs and stashes from source-commit activity.
Do not classify a project as abandoned from its age.
The owner decides which projects remain active, become dormant, or remain historical.
Search behavior for historical projects remains a rollout decision.

The old vault and its history remain read-only during the pilot.
Import preserves provenance and never treats an imported note as already checked.
Report missing bindings, duplicate identities, missing sources, and broken references without guessing repairs.
Rift restoration, project retirement, legacy work-item import, and cross-project binding changes require separate approval.

The new implementation has no legacy runtime hook bridge.
Remove the old wiki hook system during the approved cutover. Do not remove unrelated Pi extensions.
Preserve the old CLI until the replacement passes acceptance and the owner approves installation.
Do not build over the currently installed legacy executable during development.

## Delivery proposal

These are proposed delivery slices, not published GitHub issues.

| Slice | Outcome | Depends on |
| --- | --- | --- |
| 1. Retained knowledge and trusted CLI reads | Disposable vault, authority classes, source capture, checks, and status across the required source types. | Delivery approval |
| 2. Pi capture and qmd recall | Normal Pi tools and Code Mode share CLI behavior. Hybrid results carry honest evidence and index status. | 1 |
| 3. Staged maintenance and review | CLI and Pi produce reviewable repairs without overwriting notes or changing intent. | 1, 2 |
| 4. Durable runner | A compatibility spike followed by resumable maintenance through the same core operations. | 3 |
| 5. Authorized model evaluation | CLEF evidence assessment and selected generator produce staged outcomes with recorded cost and uncertainty. | 4 and provider authorization |
| 6. Pilot cleanup and rollout | Provenance-preserving import, owner project classification, then approved integration and hook replacement. | 1, 2, 3. Model cleanup also requires 5. |

Each slice must be demonstrated through its public CLI or Pi interface.
Split implementation tickets further when one slice exceeds a fresh worker's scope.
Keep the complete product acceptance criteria intact when splitting tickets.

## Verification and completion

Tests use disposable vaults and repositories. They must not touch archive data or the global qmd index.
Exercise moving refs, note edits during checks, damaged evidence, request replay, and stale search excerpts.
Exercise interrupted runs before and after provider calls and staged-result writes.
Demonstrate that personal notes do not require code evidence and that proposed repairs leave existing notes unchanged.
Demonstrate Node execution, normal Pi tools, Code Mode, cancellation, and failure results without paid prompts.

The legacy baseline reported 573 passing tests, 0 failures, and a passing typecheck.
Its scoped commands are `bun test tests/` and `bun run typecheck`.
Declare verification commands for the new packages during implementation and run them before each handoff.
Record unverified integration behavior explicitly. Passing fake-provider tests does not establish live provider compatibility.

## Open rollout choices

- The pilot vault location and personal-note import locations.
- Which attachment formats beyond text and PDF require extraction in the first usable release.
- Legacy work-item import policy and per-project lifecycle decisions.
- Git commit ownership and installation details.
- Model provider, data-sharing scope, spending, and uncertain-call retry policy.
- The supported automatic-publication mechanism after the staged workflow is proven.

Disposable implementation fixtures do not require production import locations.
These choices block the affected import, model, or cutover operations, not unrelated core work.

## Primary references

- Pi architecture inspected at `earendil-works/pi` commit `b9ab918c626ad3dd5edb58de037540f9467def88`, package version 1.0.3.
- https://github.com/earendil-works/pi/tree/b9ab918c626ad3dd5edb58de037540f9467def88/packages/durable
- https://github.com/earendil-works/pi/tree/b9ab918c626ad3dd5edb58de037540f9467def88/packages/coding-agent/docs
- https://developers.cloudflare.com/workers-ai/models/clef/
- https://github.com/vercel-labs/scriptc

Sources were inspected on 2026-10-05. Installed Pi was 1.0.2.
No live CLEF call or scriptc performance benchmark was run during shaping.
