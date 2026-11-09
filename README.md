# wiki

The `wiki` CLI maintains a local vault of plain Markdown topics with a
vault-owned type registry, digest-checked updates, local and web capture, and
qmd search. It runs from TypeScript sources under Node; there is no build step.

## Layout

| Path | Contents |
| --- | --- |
| `packages/wiki` | The `wiki` CLI. Commands, limits, and verification: [packages/wiki/README.md](packages/wiki/README.md). |
| `packages/wiki-core`, `packages/wiki-cli` | Earlier Node knowledge core and its standalone CLI, kept under `verify:next`. |
| `skills/wiki/SKILL.md` | The agent skill for vault retrieval and distilled handoff. |
| `agents/wiki.md` | The dedicated wiki agent definition. |
| `docs/` | The approved specification, the foundation proof and runtime limits, and the mutation-testing guide. |
| `scripts/` | Local single-file mutation tooling ([docs/mutation-testing.md](docs/mutation-testing.md)). |
| `archive/`, `reference/` | Non-product code. Not built or tested. |

## Install

Requirements: Node >= 22.18, Bun (as the script runner and for `bun link`),
and the external tools listed in [docs/wiki-foundation.md](docs/wiki-foundation.md).

```sh
git clone https://github.com/FasalZein/wiki.git
cd wiki
npm ci
npm ci --prefix packages/wiki
(cd packages/wiki && bun link)   # puts `wiki` on your PATH, linked to packages/wiki/bin/wiki.js
npx skills add FasalZein/wiki -g -s wiki -y
```

The linked command runs the checkout's sources. Pulling or editing the checkout
changes the installed `wiki`; keep `packages/wiki/node_modules` installed.

## Verify

```sh
bun run verify:next      # Node typecheck and tests for all packages (batch gate)
bun run boot:wiki        # boot check in a temporary vault
bun run test:tooling     # mutation tooling tests
bun run typecheck:tooling
```

Run each through `heavy` on a shared host. Use `npm ci`, not `bun install`:
`package-lock.json` is the only root lock.
