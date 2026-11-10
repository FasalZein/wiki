# Wiki architecture and performance pass

Status: approved by the owner on 2026-11-09. Parent specification: [wiki-rearchitecture.md](wiki-rearchitecture.md).
Evidence: architecture, performance, and vault recon reports in the owner's artifact store (`wiki-improve-20261109/`), summarized below.

## Owner decisions (2026-11-09)

- A1. Apply all seven deepening candidates and every recommended performance option, one slice at a time where files overlap.
- A2. Supersede D16 for `packages/wiki-core` and `packages/wiki-cli`: delete both packages. Nothing in `packages/wiki` imports them and nothing ships them. Git history keeps the code.
- A3. Amend D17: the command module exposes an in-process `run(argv, env, signal)` interface; most tests call it. A subprocess suite keeps the behaviors only a process can show: exit codes, one JSON line on stdout, signals, two-process races (AC01, AC09, AC21), and the boot check. `bin/wiki.js` stays the only code that touches `process`. No test-only CLI flags.
- A4. Change the `find` and `search sync` JSON contract: replace the full `textCoverage.inventory` list with a count and an inventory digest. The README and tests change with it.
- A5. Not adopted: caching verified path ancestors (weakens per-path symlink refusal), reusing unchanged search snapshots (D12 requires comparing actual content), and Node's compile cache (writes state outside the vault). Prebuilt test fixtures are superseded by A3.

## Vocabulary

Module, interface, depth, seam, adapter, leverage, and locality are used as in the owner's codebase-design guidance.

## Slices

Each slice keeps every existing CLI behavior and JSON field unless the slice names a contract change. Each slice runs its affected tests, `bun run verify:next` once at the end, and `bun run boot:wiki`, through `heavy`.

| ID | Slice | Files | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| S1 | Lint and navigation scaling: replace the O(notes x diagnostics) filter in `lint.ts` (about line 239) with a path set plus ancestor check; count topics per directory in one pass in `navigation.ts` (about line 36) | lint.ts, navigation.ts | none | Identical diagnostics and index bytes on existing tests; measured lint time on an invalid synthetic vault of 8,000 notes drops (before and after numbers in the PR or commit body) |
| S2 | Delete `packages/wiki-core` and `packages/wiki-cli` (A2), their tsconfig include, mutation plan entry, root `gray-matter` dependency if unused, and doc mentions | packages/, package.json, package-lock.json, scripts/, docs/, README.md, AGENTS.md | none | No reference remains outside archive/ and reference/; `npm ci`, verify:next, test:tooling, typecheck:tooling, boot:wiki exit 0 |
| S3 | Parallel test files: run package test files concurrently in the documented commands (`test:wiki`, mutation plans keep their own serial setting), with heavy slot guidance | package.json, packages/wiki/test/run.js, docs | S2 | Full packages/wiki suite passes with file concurrency; wall time before and after recorded |
| S4 | Search index body check: replace per-note `getDocumentBody` loops (qmd.ts about 182-187 and 415-418) with one bulk read, and verify index bodies once per `find` | qmd.ts | none | qmd-sync, qmd-find, qmd-cli, qmd-current, doctor tests pass; `find` on a 4,000-note synthetic vault measured before and after |
| S5 | Search index session (candidate 1): one module whose interface is a session (open on a vault; replace text index; query; read bodies; count pending embeddings; embed; inspect for doctor). It owns locks, state files and formats, SDK internals, environment binding, and cleanup order. Reads do not take the exclusive writer lock twice | qmd.ts, doctor.ts, cli.ts (search part), tests | S4 | All D10-D13 and AC13-AC15 behavior unchanged; doctor no longer re-derives index formats; real-SDK and model-smoke tests kept |
| S6 | Slim find and sync JSON (A4) | qmd.ts or the S5 module, cli.ts, README, tests | S5 | Inventory list replaced by count plus digest; README and tests updated; human output unchanged |
| S7 | Find pipeline (candidate 2): gather hits, a pure rank-and-report step (literal first, best score, filters before limit, coverage state, degraded label), revalidation behind a one-method read port; the command module only prints | S5 module, cli.ts, tests | S6 | AC15 rules covered by in-process table tests; CLI output unchanged |
| S8 | Startup: compile registry validators once per process and load the registry once per command; load yaml, ajv, and Markdown parser modules only in commands that need them | registry.ts, create.ts, lint.ts, cli.ts | S7 | `--help`, `init`, `show` and `new` timings measured before and after; behavior unchanged |
| S9 | Command interface (candidate 3, A3): `run(argv, env, signal)`, option table per command, one failure record mapper; one shared test helper; move non-process tests to `run()` | cli.ts, bin/wiki.js, tests | S8 | Subprocess suite keeps AC01, AC09, AC21 cases; suite wall time before and after recorded |
| S10 | Publication module (candidate 4): callers describe a change (new note, replacement with expected digest, retained assets, registry scaffold, index regeneration); one module takes the mutation lock, validates once, writes atomically in fixed order, logs, and returns one outcome record; index writes use the atomic routine | create.ts, update.ts, capture.ts, registry.ts, vault.ts, mutation.ts, cli.ts, tests | S9 | Every documented failure JSON field byte-identical; fault tests use a publication seam where D17 allows |
| S11 | Vault module (candidate 5): `openVault` returns a handle that owns layout, profile check, contained file access, and one note-revision read used by show, update, lint, and search | vault.ts, registry.ts, doctor.ts, read.ts, update.ts | S10 | One layout definition (fixes the missing `.wiki/locks` member in the registry copy); show and update share the strongest read protection |
| S12 | Inventory split (candidate 6): scan to an immutable inventory, validate against a compiled registry, render indexes from an inventory; a pending change is an inventory plus one note | lint.ts and its callers | S11 | AC03-AC05 wording unchanged; rule tests build inventories in-process |

After S12, the batch runs the cleaner and hardener gates, then lands through an integration PR.
