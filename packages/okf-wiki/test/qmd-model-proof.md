# QMD local-model compatibility proof

This opt-in proof tests the public QMD SDK, not the CLI integration or all of #24.
It requires macOS sandbox-exec and existing regular GGUF files. It never provisions
models. Do not add it to the model-free test runner.

Run from the repository root with each actual Node runtime being verified:

Use this command (replace the model directory and Node executable as needed):

    OKF_QMD_MODEL_DIR=/existing/models heavy -- node packages/okf-wiki/test/qmd-model-proof.js

The directory must contain these existing files:

- hf_ggml-org_embeddinggemma-300M-Q8_0.gguf
- hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf
- hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf

The proof indexes two synthetic disposable notes, embeds both, checks zero pending
embeddings, performs vector-only and typed lexical/vector retrieval, expands a
query, reranks with real models, closes the store, and requires normal process
exit. Expansion text is nondeterministic; assertions check its typed shape rather
than an exact generated string. Retrieval must rank the observatory above the
garden for an astronomy question.

The child redirects HOME/XDG/TMP and all derived data into disposable worktree
state. JavaScript guards reject network, subprocesses, and writes outside that
state. The OS sandbox also denies network and external writes from native code.
The parent compares file hashes, metadata, and symlink targets for the supplied
models and existing QMD cache/config/data before and after the child, including
failure. It hashes global derived files without opening them as databases or
reading any vault. The parent checks that the task-owned process group is gone
and removes only its own temporary state. SIGTERM/SIGINT kill only that group and
still reach the parent's external-state check. A forced kill of the parent itself
cannot run JavaScript cleanup; use a bounded supervisor that permits termination.

QMD 2.8.3 token-based chunking creates a global tokenizer separate from the store's
configured LLM. The proof therefore supplies the local embedding path through
QMD_EMBED_MODEL as well as store config. Store config alone does not bind this
global tokenizer. No remote model URI or alternate engine is used.

## Product find smoke (#25)

    OKF_QMD_PROOF=find OKF_QMD_MODEL_DIR=/existing/models heavy -- node packages/okf-wiki/test/qmd-model-proof.js

The same parent sandbox runs qmd-find-smoke-child.js. It drives the real CLI in a
disposable vault whose .wiki/config.json names the three local files: search sync
--embed, fast find (one typed lex/vec query, rerank false), a vector-only hit
with non-matching terms, and deep find (expansion plus rerank). It records Node,
QMD, node-llama-cpp versions and model hashes. The CLI binds QMD_EMBED_MODEL from
the configured embed file itself; the smoke clears it in the child environment.

## Dependency pins

QMD 2.8.3 is retained as the engine. Its exact dependency pins still contain known
advisories. Scoped overrides select node-llama-cpp 3.22.3 with simple-git 4.0.2
(which itself pins argv-parser 2.0.1), MCP server 2.3.0 (which pins core 2.3.0),
and Zod 4.6.6. These are published patched versions, not a claim that every
component is latest. The MCP/Zod versions are the smallest releases that close
the recorded advisories. Native inference and model-free SDK checks must pass
before retaining this cross-QMD-pin graph. Revisit these overrides when QMD
publishes a release with a coherent patched graph; prefer its supported pins.
Audit zero measures known registry advisories, not complete security or CLI
acceptance. MCP HTTP/Git APIs are not exposed or exercised by this proof.
