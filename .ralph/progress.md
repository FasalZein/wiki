# Progress

<!-- Each iteration appends here. Keep entries concise. -->

## Item 1 — path-traversal containment (done)
- Added `assertSafeSegment(value,label)` in `src/artifacts/paths.ts`; called it inside `projectPath` (covers all project-path consumers at the seam).
- `src/artifacts/store.ts`: import the guard; call it at top of `relocateArtifact` and `resolveArtifactPath`; added colliding-destination refusal (ArtifactValidationError) before write in relocate.
- New `tests/path-containment.test.ts`: segment-guard accept/reject, escaping-project create writes nothing outside vault, traversal-id read throws, relocate id validation, create+read+retitle regression.
- Decision: dropped the contrived "destination already occupied" test — any squatter at the destination shares the id prefix, making the id-based read ambiguous (readdir order). Guard remains in code + covered by tsc.
- Verify: build + tsc clean, 243 pass / 0 fail.

## Item 2 — supersede rollback gap (done)
- `src/cli/verbs/create.ts createWithSupersede`: Part 1 — pre-flight `--parent-prd` read (gated on `type==="slice"` to mirror `backlinkParentPrd`) before any write. Part 2 — snapshot the to-be-superseded artifact's file bytes (single read, replacing the old line-162 pre-read) and byte-restore it in the inner catch alongside removing the new file.
- DEVIATION from plan: plan's `setFields(supersededBefore.fields)` restore is WRONG — `setFields` merges onto the *current* (already-mutated) frontmatter, so the added `superseded_by` would survive. Confirmed with advisor. Used file-byte snapshot/restore instead (Bun.file().text() → Bun.write); path is stable across supersede (id/title unchanged). No new import.
- Test (`tests/cli-dedup.test.ts`): bad `--parent-prd PRD-9999` with `--supersedes SLICE-0001` → nonzero exit, no SLICE-0002, SLICE-0001 still NOT superseded. NOTE: with Part 1 in place this exercises the pre-flight, not the Part 2 restore — supersede never runs. Part 2 is the invariant backstop for future post-supersede failures; no clean seam to trigger it in a test, skipped per lean ethos.
- Verify: build + tsc clean, 244 pass / 0 fail.
