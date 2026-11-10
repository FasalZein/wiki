import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mutationOptions } from "../mutation-file.mjs";

test("scopes the command plan to one exact production file", () => {
  const options = mutationOptions("packages/wiki/src/update.ts", { HEAVY_CPUS: "8" });
  assert.deepEqual(options.mutate, ["packages/wiki/src/update.ts"]);
  assert.equal(options.testRunner, "command");
  assert.equal(options.commandRunner.command, "node --test --test-concurrency=1 packages/wiki/test/update.test.ts packages/wiki/test/concurrent-writers.test.ts");
  assert.equal(options.coverageAnalysis, "off");
  assert.equal(options.incremental, true);
  assert.equal(options.concurrency, 1);
  assert.equal(options.inPlace, false);
});

test("derives two workers from fifteen CPUs and keeps one cache per target", () => {
  const options = mutationOptions("packages/wiki/src/create.ts", { HEAVY_CPUS: "15" });
  assert.equal(options.concurrency, 2);
  assert.notEqual(options.incrementalFile, mutationOptions("packages/wiki/src/update.ts", { HEAVY_CPUS: "15" }).incrementalFile);
});

test("supports all sixteen wiki risk boundaries with serial sandbox-relative tests", () => {
  const plans = {
    "capture.ts": ["capture-text", "capture-cli", "capture-pdf", "capture-web", "concurrent-writers"],
    "update.ts": ["update", "concurrent-writers"],
    "charset.ts": ["capture-web"],
    "extract-process.ts": ["capture-pdf", "capture-web"],
    "html.ts": ["html", "capture-web"],
    "pdf.ts": ["capture-pdf", "capture-web"],
    "web.ts": ["capture-web"],
    "paths.ts": ["links-paths", "update", "capture-cli"],
    "mutation.ts": ["concurrent-writers", "write-boundaries", "update", "capture-cli"],
    "vault.ts": ["init", "write-boundaries", "capture-cli", "update"],
    "create.ts": ["create", "write-boundaries", "capture-cli", "update"],
    "qmd.ts": ["qmd-sync"],
    "publication.ts": ["create", "capture-text", "registry", "update"],
    "inventory.ts": ["inventory-rules", "capture-text"],
    "find.ts": ["find"],
    "search.ts": ["find"],
  };
  const caches = new Set();
  for (const [file, tests] of Object.entries(plans)) {
    const target = "packages/wiki/src/" + file;
    const options = mutationOptions(target, { HEAVY_CPUS: "8" });
    assert.deepEqual(options.mutate, [target]);
    const filter = file === "pdf.ts" ? "--test-name-pattern='wiki:15|PDF|pdftotext' " : "";
    assert.equal(options.commandRunner.command, "node --test --test-concurrency=1 " + filter + tests.map(name => "packages/wiki/test/" + name + ".test.ts").join(" "));
    caches.add(options.incrementalFile);
  }
  assert.equal(caches.size, 16);
});

test("the command rejects extra arguments and insufficient outer admission without starting Stryker", () => {
  const script = fileURLToPath(new URL("../mutation-file.mjs", import.meta.url));
  const extra = spawnSync(process.execPath, [script, "packages/wiki/src/update.ts", "packages/wiki/src/create.ts"], { encoding: "utf8" });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Usage:/);
  const nested = spawnSync(process.execPath, [script, "packages/wiki/src/update.ts"], {
    encoding: "utf8", env: { ...process.env, HEAVY_SLOT: "existing-test-admission", HEAVY_CPUS: "2" },
  });
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /HEAVY_CPUS/);
  assert.doesNotMatch(nested.stderr, /ProjectReader|Instrumenter/);
});

test("rejects unknown targets, globs, traversal, schemas, and missing CPU admission", () => {
  for (const target of [undefined, "", "packages/wiki/src/**/*.ts", "../packages/wiki/src/update.ts", "/packages/wiki/src/update.ts", "packages/wiki/src/cli.ts", "packages/wiki/seed/note.json", "packages/wiki/src/update.ts:1-4"]) {
    assert.throws(() => mutationOptions(target, { HEAVY_CPUS: "8" }), /Unsupported mutation target/);
  }
  for (const cpus of [undefined, "", "0", "7", "8x", "NaN", "1.5"]) {
    assert.throws(() => mutationOptions("packages/wiki/src/update.ts", { HEAVY_CPUS: cpus }), /HEAVY_CPUS/);
  }
});
