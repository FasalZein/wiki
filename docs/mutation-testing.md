# Local single-file mutation testing

This is worker tooling, not a completed batch hardening gate or a product boot proof.
It does not build root `dist` or run the installed `wiki` command.

## Install and run

Use Node ^22.18.0 or >=24.11.0 (the engine range of the locked Babel dependencies; tested on Node 24.21.0), Bun, and the host's `heavy` command.
Install root development dependencies with `heavy -- npm ci`. The root npm lock is authoritative for this tooling.
No Vitest adoption or Bun-specific Stryker runner is involved.

Run from the repository:

```sh
bun run mutation:file src/cli/output.ts
```

The command accepts exactly one literal production path. Supported affected-test plans:

| Production path | Test command inside each sandbox |
| --- | --- |
| `src/cli/output.ts` | `bun test tests/cli-links.test.ts tests/cli-search.test.ts` |
| `packages/wiki-cli/src/cli.ts` | `node --test --test-concurrency=1 packages/wiki-cli/test/cli.test.ts packages/wiki-cli/test/capture-sources.test.ts` |

| `packages/wiki/src/capture.ts` | `node --test --test-concurrency=1 packages/wiki/test/capture-text.test.ts packages/wiki/test/capture-cli.test.ts packages/wiki/test/capture-pdf.test.ts packages/wiki/test/capture-web.test.ts packages/wiki/test/concurrent-writers.test.ts` |
| `packages/wiki/src/update.ts` | `node --test --test-concurrency=1 packages/wiki/test/update.test.ts packages/wiki/test/concurrent-writers.test.ts` |
| `packages/wiki/src/charset.ts` | `node --test --test-concurrency=1 packages/wiki/test/capture-web.test.ts` |
| `packages/wiki/src/extract-process.ts` | `node --test --test-concurrency=1 packages/wiki/test/capture-pdf.test.ts packages/wiki/test/capture-web.test.ts` |
| `packages/wiki/src/html.ts` | `node --test --test-concurrency=1 packages/wiki/test/html.test.ts packages/wiki/test/capture-web.test.ts` |
| `packages/wiki/src/pdf.ts` | `node --test --test-concurrency=1 --test-name-pattern='wiki:15|PDF|pdftotext' packages/wiki/test/capture-pdf.test.ts packages/wiki/test/capture-web.test.ts` |
| `packages/wiki/src/web.ts` | `node --test --test-concurrency=1 packages/wiki/test/capture-web.test.ts` |
| `packages/wiki/src/paths.ts` | `node --test --test-concurrency=1 packages/wiki/test/links-paths.test.ts packages/wiki/test/update.test.ts packages/wiki/test/capture-cli.test.ts` |
| `packages/wiki/src/mutation.ts` | `node --test --test-concurrency=1 packages/wiki/test/concurrent-writers.test.ts packages/wiki/test/write-boundaries.test.ts packages/wiki/test/update.test.ts packages/wiki/test/capture-cli.test.ts` |
| `packages/wiki/src/vault.ts` | `node --test --test-concurrency=1 packages/wiki/test/init.test.ts packages/wiki/test/write-boundaries.test.ts packages/wiki/test/capture-cli.test.ts packages/wiki/test/update.test.ts` |
| `packages/wiki/src/create.ts` | `node --test --test-concurrency=1 packages/wiki/test/create.test.ts packages/wiki/test/write-boundaries.test.ts packages/wiki/test/capture-cli.test.ts packages/wiki/test/update.test.ts` |

The PDF plan selects all local PDF tests (`wiki:15`) and all web tests named `PDF` or `pdftotext`.
This retains real nonempty/empty extraction, exact bytes and arguments, provenance, corrupt input,
missing tools, version/status/UTF-8 errors, and cancellation/child cleanup in both entry paths.
HTML/Pandoc, charset sniffing, and HTTP-only URL/redirect/body tests remain in their other plans;
they do not exercise PDF extraction. If PDF test names change, revisit this explicit filter.
The full unfiltered PDF/web command remains a landing-suite concern, not a per-mutant requirement.
The focused boundary measured 26 passing native tests in 13.789 s; Stryker dry-run generated
54 mutants and passed the sandbox baseline in 13.483 s. At one worker, ordinary mutation
execution is approximately 54 × 13.789 = 745 s, before startup and timeout allowances.
The completed fresh-cache setup run took 11 min 7 s: 54 generated, 47 killed, 7 survived,
0 timeout/errors/no-coverage, score 87.04%. The exact native command passed again afterward
(26 pass, 0 fail); all 131 tracked source/package file hashes matched the pre-run snapshot.
This is scoped proof, not a survivor waiver or a completed hardening gate.

Other targets, globs, ranges, directories, and runtime JSON-schema files fail before Stryker starts.
Add a reviewed affected-test plan before using another production target. A plan is not a claim that its target was mutation-tested.
The Node plans need their package-local dependencies (`heavy -- npm ci --prefix packages/wiki` for the wiki package)
and existing external test prerequisites, including Git, pandoc, and pdftotext.

Stryker's supported command runner bases kills on command exit status. It reports the whole command as one synthetic test,
not the actual number of native tests. Coverage analysis is off because this runner does not provide per-test coverage.
Existing CLI tests launch source entry points within the Stryker sandbox and inherit `process.env`.
Stryker sets `__STRYKER_ACTIVE_MUTANT__` in that environment, so these children activate the same mutant.
Do not replace sandbox-relative entry points with installed or primary-checkout binaries.

The wrapper reserves `heavy` admission once for the full process tree. It requests four slots because `heavy` grants at least
two CPUs per slot. It reserves one coordinator process plus seven processes per mutation worker: Stryker worker, shell,
test launcher, native Node test-file child, CLI child, and up to two CLI descendants. Concurrency is
`floor((HEAVY_CPUS - 1) / 7)`, with no additional worker cap. Node test files run serially.
Inside an existing `heavy` job, the wrapper uses that admission and rejects a CPU grant below eight instead of acquiring nested slots.
Test commands must not add another admission layer or parallel file execution. Revisit the process budget if a plan adds more fan-out.

Reports and incremental state live under ignored `reports/mutation/<production-path>/`.
Sandboxes live under ignored `.stryker-tmp/`. Stryker mutates sandbox copies, not source files in place.
The command enables Stryker incremental mode; repeat runs can reuse previous results.
**The command runner cannot identify changed test files.** Delete the target's `incremental.json` before running after changes
to tests, non-target production dependencies, tooling/configuration, or installed dependencies. Start a hardening gate with a fresh cache.
Reused results are not newly executed mutants. No confidence threshold or survivor waiver is configured.
Timeouts count as kills only if the identical unchanged-code command passes; retain that baseline and rerun it afterward.

Runtime JSON-schema mutation is **unsupported** by this JS/TS setup. JSON schemas remain unrun and outside the measured denominator.
Do not label them tested based on TypeScript tests or schema validation.

## Tooling checks and security

Run `heavy -- bun run test:tooling`, `heavy -- bun run typecheck:tooling`, and `heavy -- bun run typecheck`.
The focused tooling tests cover exact scoping, legacy and all eleven wiki runner plans, worker derivation, cache separation, and rejected inputs.

Root overrides pin Stryker's transitive `minimatch` to 11.0.5 and `typed-rest-client`'s `qs` to 6.17.1.
These avoid GHSA-g3hv-75wg-m249 and the qs advisories reported by `npm audit` with the original Stryker graph.
The minimatch major override is exercised by the real Stryker run; review it when upgrading Stryker.
Root production `smol-toml` is pinned to 1.9.1. GHSA-7w5x-hrqm-74c2 (high, <=1.7.0)
was fixed in 1.7.1; GHSA-r4xh-jqrq-34v2 (moderate, <=1.8.0) was fixed in 1.9.0.
The only direct source caller is `src/config/config.ts`, which reads `[vault].root`.
`tests/config.test.ts` covers that contract. Tooling tests isolate malformed-comment rejection
and a 32,000-key valid document in children with five-second limits. The latter is bounded
compatibility evidence, not proof of asymptotic complexity or a performance benchmark.
Primary advisory and release references:
- https://github.com/advisories/GHSA-7w5x-hrqm-74c2
- https://github.com/advisories/GHSA-r4xh-jqrq-34v2
- https://registry.npmjs.org/smol-toml/1.9.1

Primary references checked for setup:
- https://stryker-mutator.io/docs/stryker-js/getting-started/
- https://stryker-mutator.io/docs/stryker-js/configuration/ (command runner, incremental mode, concurrency, sandbox settings)
- https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/core/package.json (Node engine)
- https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/core/src/test-runner/command-test-runner.ts (active-mutant environment)
