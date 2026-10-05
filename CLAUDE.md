# Agent guidance for this repository

## Planning and delivery routing

- The approved rearchitecture specification lives in this repository: `docs/specs/wiki-rearchitecture.md`.
- Delivery tickets and status live in GitHub Issues for `FasalZein/wiki`. Do not track delivery state in the wiki vault.
- The historical wiki vault (`/Users/tothemoon/Knowledge`, `/Users/tothemoon/Knowledge-archive`) and Linear are read-only archives. Search them for older decisions; never create, update, migrate, or delete content there.
- Do not change global agent guidance, global qmd storage, Pi settings, or installed binaries from this repository's work.

## Live legacy binary trap

- The globally installed `wiki` command resolves to this repository's `dist/cli.js`.
- Do not run `bun run build` or write anything into the root `dist/` during development. That replaces the live executable.
- New packages under `packages/` run from their own sources under Node and never write to the root `dist/`.

## Verification scope

- Legacy CLI (`src/`, `tests/`): `bun run typecheck` and `bun test tests/`. Run `tests/`, not the whole tree; `reference/` and `archive/` hold non-product code.
- New core and CLI (`packages/wiki-core`, `packages/wiki-cli`): `bun run verify:next` (Node typecheck plus `node --test` CLI integration tests, Node >= 22.18).
- Tests use disposable temp vaults and Git repositories only. Never point a test or a manual run at the archive vault.
