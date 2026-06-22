# Plan 002 — Roll back the supersede mutation on a failed create

Target commit: `5dbf09f`. If `src/cli/verbs/create.ts` around `createWithSupersede` has
drifted from the excerpt below, STOP and report.

## Why
`createWithSupersede` writes the new artifact, then runs two *post-write* steps that mutate
OTHER artifacts: `supersedeArtifact` (flips the old artifact to `status: superseded` +
`superseded_by: <new id>`) and `backlinkParentPrd`. If a post-write step throws, the catch
removes only the NEW file — it does NOT revert the supersede. Result: `create --supersedes X
--parent-prd <bad>` aborts but leaves `X` permanently `superseded`, pointing at a now-deleted
id. The code comment at lines 174-176 claims "a half-applied create never leaves an orphan" —
this is exactly that orphan.

## Current code (`src/cli/verbs/create.ts:160-185`)
```ts
  try {
    if (override.kind === "supersedes") {
      await readArtifact({ type, vaultRoot, project, id: override.id });
    }
    const dedupBlock = await advisoryDedup(...);
    if (dedupBlock !== null) return dedupBlock;
    const artifact = await createArtifact({ ... });
    try {
      if (override.kind === "supersedes") {
        await supersedeArtifact({ type, vaultRoot, project, id: override.id, by: artifact.id });
      }
      await backlinkParentPrd(type, vaultRoot, project, artifact.id, fields);
    } catch (postWriteError) {
      await removeArtifactFile(artifact.path);
      throw postWriteError;
    }
```

## What to change (two parts — both in `createWithSupersede`)

### Part 1 — Pre-flight the parent-PRD read (eliminate the common trigger)
The reported trigger is a missing/garbage `--parent-prd`. Validate it BEFORE any write,
right next to the existing supersedes pre-read (line ~162). `backlinkParentPrd` only acts
when `type` is a kind carrying `parent_prd` and `fields.parent_prd` is set, so mirror that:
```ts
    if (override.kind === "supersedes") {
      await readArtifact({ type, vaultRoot, project, id: override.id });
    }
    if (typeof fields.parent_prd === "string" && fields.parent_prd.length > 0) {
      await readArtifact({ type: "prd", vaultRoot, project, id: fields.parent_prd }); // pre-flight: fail before any write
    }
```

### Part 2 — Restore the superseded artifact if a later step still fails
Pre-flight covers the parent case, but `backlinkParentPrd`'s `setField` (or any future
post-write step) could still throw after supersede applied. Snapshot the old artifact and
restore it in the catch:
```ts
    const supersededBefore = override.kind === "supersedes"
      ? await readArtifact({ type, vaultRoot, project, id: override.id })
      : null;
    // (reuse this read instead of the separate line-162 read — don't read twice)
    ...
    const artifact = await createArtifact({ ... });
    try {
      if (override.kind === "supersedes") {
        await supersedeArtifact({ type, vaultRoot, project, id: override.id, by: artifact.id });
      }
      await backlinkParentPrd(...);
    } catch (postWriteError) {
      await removeArtifactFile(artifact.path);
      if (supersededBefore !== null) {
        // revert status + superseded_by to their pre-mutation values
        await setFields({ type, vaultRoot, project, id: override.id, fields: supersededBefore.fields });
      }
      throw postWriteError;
    }
```
`setFields` is exported from `src/artifacts/store.ts` (already imported in create.ts for the
backlink). `supersededBefore.fields` is the full pre-mutation field set, so writing it back
restores `status` and drops the `superseded_by` the failed run added.

## Out of scope — do NOT touch
- `supersedeArtifact` itself (it's correct; the bug is the missing rollback).
- The advisory dedup logic.
- Do NOT add a generic transaction/undo framework — the snapshot+restore above is the lazy,
  sufficient fix for this one two-step sequence.

## Verification
`bun run build && bunx tsc --noEmit && bun test tests/` — all green. New test passes.

## Test plan
In `tests/cli-create.test.ts` (or the existing supersede/create test file — find it with
`grep -l supersede tests/`), add: create PRD `A`; create slice `S` superseding... no — use the
real trigger: create a slice with `--supersedes <existing> --parent-prd PRD-9999` (nonexistent
PRD). Assert: (1) the command returns nonzero; (2) the superseded artifact is STILL its
original status (NOT `superseded`) and has no `superseded_by`; (3) no new slice file exists.
Mirror the temp-vault fixture setup already used in `tests/cli-dedup.test.ts:172` (which
already tests the rollback/orphan path).

## Maintenance note
Any new post-write mutation added inside the inner `try` must be either idempotent or covered
by a restore in the catch — that's the invariant this plan establishes.
