# Progress

<!-- Each iteration appends here. Keep entries concise. -->

## Item 1 — path-traversal containment (done)
- Added `assertSafeSegment(value,label)` in `src/artifacts/paths.ts`; called it inside `projectPath` (covers all project-path consumers at the seam).
- `src/artifacts/store.ts`: import the guard; call it at top of `relocateArtifact` and `resolveArtifactPath`; added colliding-destination refusal (ArtifactValidationError) before write in relocate.
- New `tests/path-containment.test.ts`: segment-guard accept/reject, escaping-project create writes nothing outside vault, traversal-id read throws, relocate id validation, create+read+retitle regression.
- Decision: dropped the contrived "destination already occupied" test — any squatter at the destination shares the id prefix, making the id-based read ambiguous (readdir order). Guard remains in code + covered by tsc.
- Verify: build + tsc clean, 243 pass / 0 fail.
