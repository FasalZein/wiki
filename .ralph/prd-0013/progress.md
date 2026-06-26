# Progress — PRD-0013

<!-- Each iteration appends one concise entry here: item number, what changed, files touched, decisions, verification result. -->

## Item 1 (SLICE-0076): frontmatter-id index + id-aware allocation

- **What changed:** Added a per-project frontmatter-`id`->path index builder and made id allocation count the max frontmatter id per prefix, so a date-named or id-only file whose frontmatter id outranks every filename no longer gets a colliding id re-minted.
- **Files touched:** `src/artifacts/id-index.ts` (new — `buildIdIndex`, maps id->path[] across all kind folders, dedups shared folders, records duplicate ids as multiple paths, ignores id-less files); `src/artifacts/id.ts` (`nextId` now takes `max(filename scan, highestFrontmatterId)`); `tests/id-generation.test.ts` (added frontmatter-collision test + two `buildIdIndex` tests).
- **Decisions:** Kept the filename scan and took the max of both sources so all existing filename-based allocation tests stay green; the index returns `Map<id, paths[]>` (not 1:1) precisely so item 3's duplicate-id doctor check can reuse the same seam.
- **Verification:** `bun run build` clean, `bunx tsc --noEmit` clean, `bun run test` 267 pass / 0 fail (was 264; +3 new tests).

