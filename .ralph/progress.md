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

## Item 3 — collision-safe ID allocation (done)
- `src/artifacts/store.ts createArtifact`: wrapped `nextId → render → write` in a bounded retry loop (MAX_ATTEMPTS=8). Each attempt recomputes `nextId`/aliases/fields/path and writes via node `writeFile(path, content, { flag: "wx" })` — exclusive create throws EEXIST on collision → `continue`. bodySections parsing hoisted out of the loop (same every attempt).
- Added `isFileExists(error)` helper (EEXIST) next to `isFileNotFound`.
- DEVIATION from plan: plan kept `writeArtifact` (Bun.write). node `writeFile` does NOT auto-mkdir parents like Bun.write, so added `mkdir(dirname(path), { recursive: true })` before the exclusive write. `relocateArtifact`/`writeFields` untouched (keep overwrite semantics).
- Test (`tests/id-generation.test.ts`): two concurrent `createArtifact` of same type via Promise.all → distinct ids, both files exist.
- Verify: build + tsc clean, 245 pass / 0 fail.

## Item 4 — qmd JSON.parse hardening (done)
- `src/integrations/qmd.ts parseQmdResults`: wrapped `JSON.parse` in try/catch → throws `QmdError` (truncated to 200 chars) so non-JSON stdout reaches the existing graceful-degradation catches instead of crashing create/sync. Exported the function for direct unit testing. Rest unchanged.
- Test (`tests/qmd-parse.test.ts`): valid array, file/filename fallbacks + none-dropped, score string-vs-number + text snippet fallback, non-array→[], malformed→throws QmdError.
- Verify: build + tsc clean, 250 pass / 0 fail.

## Item 5 — null-field validation (done)
- `src/schema/validate.ts`: `const value = input[field.name] ?? undefined` — coalesces null/undefined only (not 0/false/""), so a blank Obsidian key (gray-matter → null) is treated as absent: blank optional passes, blank required → "required" (not "type mismatch"). Matched plan excerpt exactly. matchesType untouched; return still passes `input` through (null preserved on disk).
- Tests: `tests/schema.test.ts` — null optional → ok:true; null required → ok:false reason "required". `tests/artifacts.test.ts` — inject blank `related_prd:` into a decision's frontmatter, then setField unrelated `status` succeeds (would throw "type mismatch" pre-fix).
- Verify: build + tsc clean, 253 pass / 0 fail.

## Item 6 — project-resolution consolidation (done)
- Part A: routed 9 inline `join(vaultRoot,"projects",x)` through `projectPath()` (path-containment seam) in status/search(×3)/doc/create/fmt/sync/resolve-project/project.ts. Renamed local `projectPath` consts to `projPath` to avoid shadowing the imported fn. Dropped now-unused `join` imports in search/doc/sync/resolve-project.
- Part B: fmt + sync now run the status.ts pattern (loadProjectConfig → ProjectConfigError → projectErrorMessage + exit 10) for a nonexistent `--project`; the "no project at all" terse exit-1 path unchanged. fmt keeps assertProjectStructure after the config check; sync's pre-flight is added before the docs gate.
- Test: cli-fmt.test.ts — nonexistent `--project` exits 10 and lists wiki-v2.
- Verify: build + tsc clean, 254 pass / 0 fail.

## Item 7 — de-workflow dead-code removal (done)
- 7a `test_command`: removed `ProjectConfig.test_command` member + loader line (config/project.ts); removed `testCommand` flag/var, dropped it from `_project.md` template + both console.error lines + comments (cli/verbs/project.ts); dropped `--test-command` from usage string/flags/example (cli/usage.ts). Existing tests that embed `test_command` in fixture frontmatter are harmless (unknown keys ignored) — none assert on create output, so left them.
- 7b `appendField`: deleted the function + `AppendFieldInput` type (store.ts); removed its test block + import in tests/artifacts.test.ts.
- 7c `research.sources`: removed `WikiConfig.research` member (types.ts); removed `sources`/`defaultResearchSources`/now-unused `isStringArray` from config.ts. Updated tests/config.test.ts (2 cases) to expect `{ vault: { root } }` only.
- 7d deleted orphan tests/js-yaml.d.ts.
- Verify: build + tsc clean, 253 pass / 0 fail (−1 from removed appendField test).
