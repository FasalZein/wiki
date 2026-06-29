/**
 * SLICE-0108 SPIKE characterization (PRD-0018).
 *
 * Unknown resolved: when a qmd collection has been registered (`qmd collection add`)
 * but never embedded (`qmd embed`), does `qmd query` against it ERROR or quietly
 * return empty?
 *
 * FINDING (qmd 2.5.3, observed against the real /opt/homebrew/bin/qmd binary on a
 * throwaway temp index, then pinned here as a fake-qmd that reproduces the exact
 * exit/stdout/stderr contract so the suite is deterministic and never touches a
 * real vault):
 *
 *   1. registered-but-never-embedded  -> `qmd query --collection <name>` returns
 *      LEXICAL results, exit 0, with only a stderr warning ("N documents need
 *      embeddings"). NOT an error, NOT an empty result. `collection add` indexes
 *      the files lexically up front; embeddings only improve vector ranking.
 *   2. absent / never-added           -> `qmd query --collection <name>` prints
 *      "Collection not found: <name>" to stderr and exits 1 (a hard error).
 *   3. empty index, no --collection   -> returns `[]`, exit 0.
 *
 * CONSEQUENCE FOR SLICE-0109: the read-only search membership branch must treat a
 * present-but-unembedded collection as an ordinary queryable collection (it yields
 * lexical hits), and warn-and-skip ONLY entirely-absent collections (those are the
 * ones that error). At our integration surface this maps to runQuery: a never-added
 * collection makes qmd exit 1 with empty stdout, which runQmd turns into a thrown
 * QmdError; an unembedded collection returns results with a stderr warning, which
 * runQmd passes through. Both behaviors are pinned below.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCollections, QmdError, runQuery } from "../src/integrations/qmd";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// fake-qmd reproducing the real qmd 2.5.3 contract observed in the spike:
//   - `collection list` prints one registered collection ("spike").
//   - `query ... --collection spike` (registered, unembedded): JSON results on
//     stdout, an embeddings warning on stderr, exit 0.
//   - `query ... --collection ghost` (absent): "Collection not found" on stderr,
//     empty stdout, exit 1.
async function createFakeQmd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qmd-unembedded-"));
  tempPaths.push(root);
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -uo pipefail
case "\${1:-}" in
  collection)
    if [ "\${2:-}" = "list" ]; then
      printf 'Collections (1):\\n\\nspike (qmd://spike/)\\n  Pattern:  **/*.md\\n  Files:    1\\n  Updated:  0s ago\\n'
    fi
    ;;
  query)
    if printf '%s\\n' "$@" | grep -q 'ghost'; then
      echo "Collection not found: ghost" 1>&2
      exit 1
    fi
    echo "Warning: 1 documents (100%) need embeddings. Run 'qmd embed' for better results." 1>&2
    printf '[{"file":"qmd://spike/doc.md","score":0.9,"snippet":"the quick brown fox"}]'
    ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);
  return qmdCommand;
}

describe("SLICE-0108 spike: registered-but-never-embedded collection", () => {
  test("querying a registered-but-unembedded collection returns lexical results (not error, not empty)", async () => {
    const qmd = await createFakeQmd();
    const results = await runQuery(qmd, "lex: fox", ["spike"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("qmd://spike/doc.md");
  });

  test("querying an absent (never-added) collection throws QmdError with 'Collection not found'", async () => {
    const qmd = await createFakeQmd();
    await expect(runQuery(qmd, "lex: fox", ["ghost"])).rejects.toThrow(QmdError);
    try {
      await runQuery(qmd, "lex: fox", ["ghost"]);
      throw new Error("expected runQuery to throw for an absent collection");
    } catch (error) {
      expect(error).toBeInstanceOf(QmdError);
      expect((error as QmdError).summary).toContain("Collection not found");
    }
  });

  test("collection list reports the registered collection so search can detect absent ones up front", async () => {
    const qmd = await createFakeQmd();
    expect(await listCollections(qmd)).toEqual(["spike"]);
  });
});
