// Test-only wrapper for the CLI guard's fake-inference modes. The real SDK store,
// SQLite index and lexical retrieval stay real; only model inference is replaced
// (query expansion, query embedding/reranking inside search, document embedding).
// Before each faked inference it runs the SDK's real model-cache preparation, which
// QMD 2.8.3 resolveModel performs first even for absolute local model files.
import fs from "node:fs";
import * as real from "@tobilu/qmd";
export * from "@tobilu/qmd";

const mode = process.env.OKF_QMD_CLI_GUARD ?? "";
const log = (entry) => fs.appendFileSync(process.env.OKF_QMD_CALL_LOG, JSON.stringify(entry) + "\n");
// Source event: deliver the CLI's real SIGTERM handler while inference is in flight.
const interrupt = (seam) => { if (mode === "fake-inference-interrupt-" + seam && !process.emit("SIGTERM")) throw new Error("No cooperative SIGTERM listener"); };
// Injected local inference failure: vector/rerank search and expansion throw.
const vectorFail = () => { if (process.env.OKF_QMD_FAKE_VECTOR === "fail") throw new Error("Injected local vector inference failure"); };
// Source event: another editor changes or removes a note while search inference runs.
const move = () => {
  const target = process.env.OKF_QMD_MOVE_PATH;
  if (mode === "fake-inference-move-edit") fs.appendFileSync(target, "Concurrent edit\n");
  if (mode === "fake-inference-move-delete") fs.unlinkSync(target);
};
export async function createStore(options) {
  const store = await real.createStore(options);
  const llm = store.internal.llm;
  log({ op: "createStore", models: options.config?.models ?? null, tokenizer: process.env.QMD_EMBED_MODEL ?? null, modelCacheDir: llm.modelCacheDir });
  if (mode === "fake-inference-expand-fail") {
    // Lower seam: QMD's real LlamaCpp.expandQuery (its catch and question fallback) and
    // real store expansion filtering/cache run; only native generation setup fails.
    llm.ensureGenerateModel = async () => {};
    llm.ensureLlama = async () => ({ createGrammar: async () => { log({ op: "createGrammar" }); throw new Error("Injected native generation context failure"); } });
    return store;
  }
  if (mode === "fake-inference-native-fail") {
    // Lower seam: QMD's real structured search and real LlamaCpp.embedBatch run over a
    // real vector table; only native embedding-context allocation fails.
    if (llm) {
      store.internal.ensureVecTable(4);
      llm.ensureEmbedContexts = async () => { log({ op: "ensureEmbedContexts" }); throw new Error("Injected native context allocation failure"); };
    }
    return store;
  }
  store.expandQuery = async (query, ...rest) => {
    llm.ensureModelCacheDir();
    log({ op: "expandQuery", query, rest });
    interrupt("expand");
    vectorFail();
    return [{ type: "lex", query: "telescope" }, { type: "vec", query }];
  };
  store.search = async (request) => {
    llm.ensureModelCacheDir();
    log({ op: "search", request });
    interrupt("search");
    vectorFail();
    move();
    // Deterministic stand-in for vector/rerank inference: union of real lexical hits.
    const scores = new Map();
    for (const q of request.queries) {
      if (q.type !== "lex") continue;
      for (const hit of await store.searchLex(q.query, { collection: request.collection })) scores.set(hit.filepath, Math.max(scores.get(hit.filepath) ?? 0, hit.score));
    }
    return [...scores].map(([file, score]) => ({ file, score }));
  };
  const update = store.update.bind(store);
  store.update = async (...args) => { log({ op: "update" }); return update(...args); };
  store.embed = async (...args) => {
    llm.ensureModelCacheDir();
    log({ op: "embed", args });
    interrupt("embed");
    if (process.env.OKF_QMD_FAKE_EMBED === "fail") throw new Error("Injected local embedding failure");
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0 };
  };
  return store;
}
