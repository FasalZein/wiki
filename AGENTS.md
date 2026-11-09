# Agent guidance for this repository

## Planning and delivery routing

- The approved rearchitecture specification lives in this repository: `docs/specs/wiki-rearchitecture.md`.
- Delivery tickets and status live in GitHub Issues for `FasalZein/wiki`. Do not track delivery state in the wiki vault.
- The historical wiki vault (`/Users/tothemoon/Knowledge`, `/Users/tothemoon/Knowledge-archive`) and Linear are read-only archives. Search them for older decisions; never create, update, migrate, or delete content there.
- Do not change global agent guidance, global qmd storage, Pi settings, or installed binaries from this repository's work.

## Live command trap

- The global `wiki` command is a `bun link` (run in `packages/wiki`) of the main checkout's `packages/wiki/bin/wiki.js`. Landing on the main checkout changes the live command.
- The main checkout must keep `packages/wiki/node_modules` installed: `heavy -- npm ci --prefix packages/wiki`.

## Verification scope

- `reference/` and `archive/` hold non-product code. Do not build or test them.
- Node packages (`packages/wiki-core`, `packages/wiki-cli`, `packages/wiki`): `bun run verify:next` covers source and tests at the batch gate (Node typecheck plus `node --test` CLI integration tests, Node >= 22.18).
- Boot check for `packages/wiki`: `heavy -- bun run boot:wiki` (source CLI in a temp vault; exits nonzero on any failed step). Runtime support and operating limits: `docs/wiki-foundation.md`.
- Root dependencies: `package-lock.json` is the only root lock. Install with `heavy -- npm ci`; never run `bun install` at the root, because it writes a second lock (`bun.lock`). `bun run <script>` is fine.
- Tests use disposable temp vaults and Git repositories only. Never point a test or a manual run at the archive vault.

## Evidence and authored Markdown

- Bind code evidence to its canonical repository path and configured local ref, not file bytes alone. Disable Git replacement objects for evidence lookups.
- Parse authored frontmatter only as safe YAML data. Bypass gray-matter's failed-parse cache. Do not enable executable language engines or raw-byte identity filters.
- Referenced notes need their own retained file digest. Do not inherit their trust or recursively attest a citation graph.
- Fail closed on incomplete request claims and ambiguous equal-time outcomes. Claim vault-wide check identity atomically before effects; a claim does not prove completion. Checker metadata is asserted provenance, never authenticated approval.
- Synchronize race and cancellation tests at observable source or extractor events. Do not add polling delays to force an interleaving.
