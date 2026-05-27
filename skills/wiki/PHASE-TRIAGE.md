---
based-on: mattpocock/skills/engineering/triage@b8be62f
fork-rationale: Adapts triage to wiki artifact state, vault truth, and CLI repair instead of ticket queues.
---
# Phase: triage

Goal: restore a trustworthy next action when state, evidence, or scope is
unclear.

## When triage fires

- Stale session: agent starts with no active context or an expired handover.
- Context loss: compaction happened, or a new agent picked up mid-project.
- Mid-project pickup: resuming work started by a different agent or human.

## Artifact states

Wiki artifacts have status fields instead of issue labels. The canonical states:

**PRDs**: `draft` → `ready` → `in-progress` → `closed`
**Slices**: `planned` → `red` → `green` → `closed` (or `blocked`)
**Handovers**: `open` → `completed`
**Decisions**: `proposed` → `accepted` (or `deprecated`, `superseded`)

When states conflict or don't make sense, flag it and investigate before
changing anything.

## Show what needs attention

Run `wiki status --project <name> --with-doc` and present three buckets:

1. **Stale** — artifacts whose status doesn't match their content (e.g. slice
   is `green` but `green_log_ref` is empty).
2. **Blocked** — slices with `blocked_by` pointing to unclosed slices.
3. **Open handovers** — handovers still marked `open` from finished sessions.

Show counts and a one-line summary per artifact. Let the user pick what to
address.

## Triage a specific artifact

1. **Gather context.** Read the full artifact via `obsidian read`. Parse any
   prior handovers so you don't re-ask resolved questions. Explore the codebase
   using the project's domain glossary, respecting ADRs in the area.
   Search for prior rejected decisions before evaluating new requests:

   ```
   wiki search "<topic>" --project <name> --type decision
   ```

   If a match exists, surface it: "We rejected this before (ADR-NNNN) because
   [reason]. Do you still feel the same way?" The user may confirm (note in
   existing ADR), reconsider (supersede and re-grill), or disagree (proceed
   normally).

2. **Recommend.** Tell the user your assessment with reasoning, plus a brief
   codebase summary relevant to the artifact. Wait for direction.

3. **Reproduce (bugs only).** Before any grilling, attempt reproduction: read
   the reported behavior, trace the relevant code, run tests. Report what
   happened — successful repro, failed repro, or insufficient detail.

4. **Grill (if needed).** If the artifact needs fleshing out, run a grill
   session per `PHASE-PLAN.md`. Update `domain-language.md` and create ADRs
   as decisions crystallize.

5. **Apply the outcome.** Fix the artifact state:
   - Resume work → identify the correct phase and route there.
   - Needs more context → write specific questions, don't say "provide more info."
   - Write a handover → if the session produced useful context.

## Recording out-of-scope decisions

When a feature request or enhancement is deliberately rejected during triage or
a grill session, record it as an ADR with status `rejected`:

```
wiki create decision --project <name> --title "Dark mode support"
obsidian property:set <decision-file> status rejected
obsidian property:set <decision-file> context "Requested during triage"
obsidian property:set <decision-file> decision "Out of scope — [substantive reason]"
```

The decision field should be substantive — not "we don't want this" but why.
Good reasons reference project scope/philosophy, technical constraints, or
strategic decisions. Avoid referencing temporary circumstances ("we're too
busy right now") — those are deferrals, not rejections.

**When NOT to record:** bug reports (only enhancement rejections) and deferrals
("not now" is not "never" — track as a planned slice instead).

## Resuming a previous session

If prior handovers exist, read them. Check whether outstanding questions have
been answered by subsequent work. Present an updated picture before continuing.
Don't re-ask resolved questions.

## Step-by-step repair

### Step 1 — Read current state

```
wiki status --project <name> --with-doc
```

### Step 2 — Search for context

```
wiki search <query> --project <name>
```

### Step 3 — Inspect artifacts

```
obsidian read <artifact-file>
```

### Step 4 — Identify and fix drift

- **Stale slice**: `planned` but parent PRD is `in-progress`. Start work or
  mark blocked.
- **Missing evidence**: `green` but `green_log_ref` empty. Re-run
  `wiki green <id> --project <name>`.
- **Orphan handover**: `open` but session is finished.
  `obsidian property:set <handover-file> status completed`.
- **Blocked slice**: check if blocker is now closed.

## Exit criteria

Triage is done when:
- The agent has full context of the project state.
- The next slice to work on is identified.
- The correct phase route is known.

If triage reveals scope is unclear or requirements have shifted, chain to the
plan (grill) phase. See `PHASE-PLAN.md`.
