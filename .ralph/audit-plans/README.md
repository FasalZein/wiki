# Audit plans — wiki CLI (`/improve`, vetted)

Written against commit `5dbf09f`. Source: read-only `/improve` audit (standard depth, 4
parallel auditors), every finding confirmed against the cited code. Executed via the Ralph
loop (`.ralph/plan.md`, `.ralph/items.json`). Risky-first order.

| # | Plan | Category | Effort | Risk | Adds tests |
|---|------|----------|--------|------|-----------|
| 001 | Path-traversal containment (`--project` + `id`) | Security | S–M | LOW | yes |
| 002 | Supersede rollback gap | Bug (data integrity) | S–M | MED | yes |
| 003 | `nextId` TOCTOU race | Bug (concurrency) | M | MED | yes |
| 004 | qmd `JSON.parse` hardening | Bug + Test | S | LOW | yes |
| 005 | `null`-field validation | Bug | S | LOW | yes |
| 006 | Project-resolution consolidation | Tech debt | S+M | LOW | maybe |
| 007 | De-workflow dead-code removal | Tech debt | S | LOW | no (tsc gate) |
| 008 | `test` script footgun | DX | S | LOW | no |

## Dependency notes
- 001 adds `assertSafeSegment` to `paths.ts` and routes the `id` guard through `store.ts`.
  006 routes 9 inline `join(...,"projects",...)` sites through `projectPath()` — after 001
  that helper is also where project-name containment lives, so 006 strengthens 001's coverage.
  Order 001 before 006 (current order) so 006 inherits the guard; not strictly required.
- All other items are independent.

## Considered and rejected (do not re-audit)
Command injection — none (every `qmd`/`git` call is `Bun.spawn([...])`, no shell). No secrets,
no prototype pollution. Deps clean. `fmt.ts` is cohesive, not a god module. `matter()` call
sites are not real duplication. Docs accurate. The absence of TDD gates / lifecycle / phases /
Obsidian-writer is BY DESIGN (ADR-0034), not debt. `dedup.ts` advisory + `create` not
auto-indexing are intentional. `relocate` overwrite folded into 001; thin `paths`/`config`
unit tests deferred (low value).
