// Test-only wrapper for the CLI guard's fake-inference modes. The real SDK store,
// SQLite index and lexical retrieval stay real; only model inference is replaced
// (query expansion, query embedding/reranking inside search, document embedding).
import fs from "node:fs";
import * as real from "@tobilu/qmd";
export * from "@tobilu/qmd";

const log = (entry) => fs.appendFileSync(process.env.OKF_QMD_CALL_LOG, JSON.stringify(entry) + "\n");
export async function createStore(options) {
  const store = await real.createStore(options);
  log({ op: "createStore", models: options.config?.models ?? null, tokenizer: process.env.QMD_EMBED_MODEL ?? null });
  store.expandQuery = async (query, ...rest) => {
    log({ op: "expandQuery", query, rest });
    return [{ type: "lex", query: "telescope" }, { type: "vec", query }];
  };
  store.search = async (request) => {
    log({ op: "search", request });
    // Deterministic stand-in for vector/rerank inference: union of real lexical hits.
    const scores = new Map();
    for (const q of request.queries) {
      if (q.type !== "lex") continue;
      for (const hit of await store.searchLex(q.query, { collection: request.collection })) scores.set(hit.filepath, Math.max(scores.get(hit.filepath) ?? 0, hit.score));
    }
    return [...scores].map(([file, score]) => ({ file, score }));
  };
  store.embed = async (...args) => {
    log({ op: "embed", args });
    if (process.env.OKF_QMD_FAKE_EMBED === "fail") throw new Error("Injected local embedding failure");
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0 };
  };
  return store;
}
