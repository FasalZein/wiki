# Wiki foundation: proof, runtime support, and limits

This document describes the disposable foundation of the new `wiki` CLI in
`packages/wiki`. It tells you how to prove that the foundation works, which
runtimes were tested, and which limits you must know before you use it on a real
vault. Command details are in [the package README](../packages/wiki/README.md).
The approved decisions are in [the specification](specs/wiki-rearchitecture.md).

## Glossary and path identity

The domain terms are defined in the specification's
[Domain Glossary](specs/wiki-rearchitecture.md#domain-glossary). The decision to
identify a topic by its canonical scoped path, with a vault-owned type registry
instead of numeric IDs or a fixed taxonomy, is recorded once in the
[compact ADR](specs/wiki-rearchitecture.md#compact-adr-record-path-identity-and-configurable-profile).
This document does not repeat them. The practical consequence: a rename changes
the identity of a topic. Lint reports the broken links. No automatic migration exists.

## Proof commands

Run every command from the repository root, through `heavy`. None of them runs
the installed `wiki` command.

| Command | What it proves |
| --- | --- |
| `heavy -- bun run boot:wiki` | Boot check. It starts `packages/wiki/bin/wiki.js` under the current Node, in a new temporary directory with a decoy HOME. It runs init, type list, lint, new, show, an update with a stale expected digest (must exit 3 and leave the topic unchanged), and index --check. It removes the directory and exits 0. Any failed step exits 1. It loads no search engine or model. |
| `WIKI_TEST_PATTERN='wiki:20' heavy --slots 2 -- bun run test:wiki` | Runs the boot script as a real process. Checks the step list, the removal of its temporary state, and a nonzero exit when it cannot complete. |
| `WIKI_QMD_PROOF=handoff WIKI_QMD_MODEL_DIR=/existing/models heavy -- node packages/wiki/test/qmd-model-proof.js` | Complete synthetic handoff smoke with real local models. See below. |
| `heavy --slots 2 -- bun run verify:next` | Batch gate. Its TypeScript project includes this package, and it runs all of this package's tests through `packages/wiki/test/run.js --all`, which ignores `WIKI_TEST_PATTERN`. Do not also run `verify:wiki` at the gate. |

`test:wiki` and `verify:next` both run `packages/wiki/test/run.js`, which runs four
test files at the same time (`FILE_CONCURRENCY`, `--test-concurrency=4`). Each test file is one Node process.
Most tests run commands inside it, and the others start one CLI process at a
time, so a run usually has about four busy processes: claim `heavy --slots 2`, one
slot per two processes. Brief peaks are higher: two race tests start two CLI
processes at once, and some commands start git or extractor children. If you change the concurrency, change the slot claim with it.
When `WIKI_TEST_PATTERN` is set and matches no test, `test:wiki` exits 1 with a
message, so a mistyped pattern cannot read as a passing run.
The mutation plans in `scripts/mutation-file.mjs` stay serial
(`--test-concurrency=1`), one Stryker worker per sandbox.

Measured on 2026-11-09, before slices 48 to 51 moved most tests in process and
added tests (14-core Apple Silicon, other jobs running, 1-minute load
about 23 to 33), full `packages/wiki` suite, 25 files, 532 tests: `heavy --slots 2 --
bun run test:wiki` passed all 532 in 191 s; `heavy --slots 1 -- node --test
--test-concurrency=1 packages/wiki/test/*.test.ts` passed all 532 in 890 s. A
`verify:next` run overlapped part of the serial run, so the serial time is high.
On 2026-11-10 the suite has 29 files and 564 tests: `heavy --slots 2 -- bun run
verify:next` (typecheck plus every test) passed all 564; the test step took 83 s.

The handoff smoke runs under macOS `sandbox-exec` with network denied and writes
allowed only in a disposable directory. Through the real CLI it runs: init, type
list, lint, two new topics, show, a refused stale update, an applied update with
the digest from show, local text capture, index --check, lint, `search sync
--embed`, fast find, deep find (query expansion and reranking), a second find
that returns the captured source, show of the deep-find hit (same digest), and
doctor. It uses the three existing GGUF files in the model directory read-only
through `search.models`. The product puts the SDK model cache inside the vault
(`.wiki/search/sdk-cache`); the smoke checks that this cache stays empty and that
nothing appears under the decoy HOME. The parent process hashes the model files
and the global qmd cache, config, and data directories before and after the run,
and fails on any difference or on a live child process group. See
[the proof notes](../packages/wiki/test/qmd-model-proof.md).

## Supported runtime

The package declares Node >= 22.18 (`packages/wiki/package.json` `engines`). It runs
from TypeScript sources with Node's built-in type stripping. On 2026-11-09 the boot
check and the handoff smoke passed on:

- macOS 27.0 (build 26A428), Apple Silicon (arm64)
- Node v24.21.0 and Node v22.23.4
- @tobilu/qmd 2.8.3, node-llama-cpp 3.22.3 (package overrides), pandoc 3.8.3, pdftotext 26.04.0
- Models (SHA-256): `hf_ggml-org_embeddinggemma-300M-Q8_0.gguf`
  `f470220f84b6235197541352d22f10bf00098a8242c18eaacea9c8a4add557bc`,
  `hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf`
  `000dfb1c06efa6a049e9f64ba921c3740e2454f62abab6fa10e77bd30bb2bcc0`,
  `hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf`
  `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`

Not verified:

- Node 22.18.0 to 22.23.3 (the declared floor itself), Node 26, and Bun as the CLI runtime.
- Linux, Windows, and Intel macOS. The real-model proof needs macOS `sandbox-exec`; no equivalent isolation exists for other platforms yet.
- Other GPU or CPU inference backends, other model files, and larger vaults.
- Web and PDF capture in the handoff smoke. Their real-process tests are `wiki:15` and `wiki:16`; the smoke captures one local text document.
- Obsidian, desktop, and hosted-provider behavior. The CLI makes no hosted calls.

## Schema, link, and profile rules

- A vault has profile `wiki-okf`, version 1. Other profiles or versions are refused (exit 5).
- The registry (`.wiki/types/*.json`) defines the accepted types. A type schema can narrow the common profile, but cannot remove required fields, the flat-data rule, or lifecycle values (draft, stable, deprecated). Run whole-vault lint in the same change as any registry change.
- Frontmatter is parsed as safe YAML data only. Unknown tags, duplicate keys, and language-tagged blocks are refused.
- Links are document-relative Markdown links. Wikilinks and root-prefixed links fail lint. Internal targets must be existing topics, generated indexes, or retained assets. External links get syntax checks only, never network requests.
- Generated directory indexes are derived data. `index --check` and whole-vault lint report them as missing or stale; `index` regenerates them.

## Source-retention limits

- Capture keeps the original bytes and the complete extracted UTF-8 text under `<scope>/assets/<slug>/`. Later reads use only these files and never fetch again.
- A source capture records what was observed. It does not prove that the content is correct or current.
- No size limit exists. Input, extraction, and rendering are held in memory.
- Web capture fetches one resource and its redirects. It does not crawl, execute scripts, or keep transfer framing.
- No OCR. Unsupported or unreadable material fails without invented content.
- Distinct captures of identical bytes are kept as separate copies. No deduplication exists.

## Manual lock inspection

Two locks exist. Neither is reclaimed by age or by PID.

- `.wiki/locks/mutation.lock` serializes cooperating CLI content writes (new, type add, capture, `index` without `--check`, and `update` without `--dry-run`). Follow the README section "Explicit stale-lock recovery": stop other writers, read the token, PID, hostname, and time, check the real process on that host, and remove the lock file only when no owner is active. A PID alone can be reused.
- `.wiki/search/writer.lock` serializes every command that writes the search index: `search sync`, `search sync --embed`, and `find` (fast and deep). The file is empty: it has no token, PID, host, or time. Before you remove it, stop every `wiki` process that uses this vault on every host that can reach it, and confirm with `ps` (look for any `wiki ... --vault <dir>` or `WIKI_VAULT` process that runs `find` or `search`). If you cannot confirm this, keep the lock. After removal, the derived `.wiki/search/` state can be deleted and rebuilt from Markdown with `search sync`.

`doctor` reports held locks and retained temporary files. It never removes them.

## Partial-write recovery

Note, asset, index, and log writes are separate files, not one transaction. Each
file is published atomically, so no file is left half written.

- When a later step fails after a file was published, the result has `ok: false` and `written: true` with the published paths and digests. Do not retry the content write.
- Run `index` to repair generated navigation. Then inspect `log.md` and add a missing entry by hand only if needed. Do not invent its time.
- A failed write can leave a temporary file in `.wiki/tmp/` or a reserved capture directory under `<scope>/assets/<slug>/`. The failing command reports its path, and `doctor` lists every `.wiki/tmp/` entry. Compare it with the published paths, `log.md`, and the generated indexes before you remove it. Do not retry the publication blindly.
- An interrupted `init` is not repaired by a second `init`. Inspect the retained files and choose a new empty directory or repair by hand.
- An interrupted `search sync` publishes no complete coverage receipt. Run it again. If it reports the index writer lock as busy, follow the writer-lock steps in Manual lock inspection first.

## External-editor race

The mutation lock coordinates only cooperating `wiki` processes on one host. It does
not stop Obsidian, Git, or another editor. `update` checks the expected full-file
digest and re-reads the target just before an atomic rename, but an outside write
between that read and the rename is lost. This is not compare-and-swap. Close the topic in
Obsidian and other editors, and do not run Git operations that touch it, before you
apply an update. `update --dry-run` only previews the diff; it gives no protection.
An outside write that lands between the final read and the rename is lost without a
report. Search coverage and find results describe the bytes read
during the command, not files frozen until it returns.

## Text coverage, embeddings, and source correctness

These are three separate claims. A result can satisfy one and not the others.

- **Text coverage** (`textCoverage`): every valid topic in the captured inventory is in the search index with the same full-file digest. `search sync` and `doctor` report it.
- **Embedding coverage** (`embeddingCoverage`): the configured local embedding model has vectors for every indexed content hash. A complete text index can still have pending embeddings; `search sync --embed` fills them.
- **Source correctness**: whether a claim agrees with the outside world. The foundation never asserts it. `doctor` reports `sourceCorrectness: "not-asserted"`.

Find revalidates every hit against the current file digest before it returns text.
Schema-valid, indexed, and embedded does not mean true, reviewed, or owner-approved.
