# Progress

<!-- Each iteration appends here. Keep entries concise. -->

## Iter 1 — SLICE-0071 (required summary field) ✅
- Added `summary: { type: string, required: true, min: 10, max: 200 }` to all 5 template schemas (prd, slice, decision, doc, handoff), placed after `title` (after `project` for handoff).
- Rendered `{{summary}}` as a body line under the `>` metadata line in each template. summary is a schema field, so createGeneric auto-derives the `--summary` flag and store validation enforces required+min.
- Grandfather verified: `readArtifact` does NOT call `validate()` (store.ts:70), so the ~2,900 existing summary-less files keep reading fine. Enforcement is create/set only (store.ts:168 create, :265 writeFields/set).
- NOTE (max not enforced): `validate.ts` checks `min` for strings but never `max` (true for the existing `title: max 80` too). Declared `max: 200` for spec parity but did NOT add a global max check — zero acceptance-criteria payoff, regression surface across every max-declaring field. Flagged for a possible later slice.
- Fixtures: added `--summary`/`summary:` to every create/createArtifact call and exact-error `validate()` assertions across artifacts, schema, path-containment, id-generation, cli-prd/doc/decision/slice/dedup/mutate/one-shot/create-path-echo/fmt tests.
- New tests: prd renders summary line; prd create without --summary exits 1 naming summary; decision artifact stripped of summary still reads (grandfather).
- Verify: `bun run build && bunx tsc --noEmit && bun test tests/` → 256 pass, 0 fail.

## Iter 2 — SLICE-0072 (per-project index.md at sync) ✅
- New `src/artifacts/index-md.ts`: `writeProjectIndex(vaultRoot, project)` recursively scans `projects/<project>/` for *.md (excludes index.md/_project.md), parses frontmatter via gray-matter, skips files whose id prefix doesn't resolve to a kind (typeForId undefined). Sorts by KIND_ORDER (wiki.json definition order — stable, not readdir order) then id.localeCompare. Renders plain markdown list `- [[id]] title (status) — summary`; missing status/summary render empty (grandfathered files don't crash). Fixed header `# <project> index`, trailing newline → byte-identical re-run.
- sync.ts: import + one call after the embed loop, inside the try, before `return {code:0}`, called once with `project` (not per-target — research isn't a project dir; qmd failure correctly skips index). No stdout writes.
- ponytail: list not table — summaries can contain `|`.
- Tests: cli-sync — sync writes index, sorted PRD<SLICE-0001<SLICE-0002, grandfathered PRD without summary renders, re-run byte-identical. cli-prd — create never writes index.md (AC#4, create stays pure).
- Verify: bun run build && bunx tsc --noEmit && bun test tests/ → 258 pass, 0 fail.
