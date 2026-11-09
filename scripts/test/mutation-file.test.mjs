import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mutationOptions } from "../mutation-file.mjs";

test("scopes the Bun command plan to one exact production file", () => {
  const options = mutationOptions("src/cli/output.ts", { HEAVY_CPUS: "8" });
  assert.deepEqual(options.mutate, ["src/cli/output.ts"]);
  assert.equal(options.testRunner, "command");
  assert.equal(options.commandRunner.command, "bun test tests/cli-links.test.ts tests/cli-search.test.ts");
  assert.equal(options.coverageAnalysis, "off");
  assert.equal(options.incremental, true);
  assert.equal(options.concurrency, 1);
  assert.equal(options.inPlace, false);
});

test("uses serial native Node tests for the Node CLI plan", () => {
  const options = mutationOptions("packages/wiki-cli/src/cli.ts", { HEAVY_CPUS: "15" });
  assert.equal(options.commandRunner.command, "node --test --test-concurrency=1 packages/wiki-cli/test/cli.test.ts packages/wiki-cli/test/capture-sources.test.ts");
  assert.equal(options.concurrency, 2);
  assert.notEqual(options.incrementalFile, mutationOptions("src/cli/output.ts", { HEAVY_CPUS: "15" }).incrementalFile);
});

test("supports all eleven wiki capture/update risk boundaries with serial sandbox-relative tests", () => {
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
  assert.equal(caches.size, 11);
});

test("the command rejects extra arguments and insufficient outer admission without starting Stryker", () => {
  const script = fileURLToPath(new URL("../mutation-file.mjs", import.meta.url));
  const extra = spawnSync(process.execPath, [script, "src/cli/output.ts", "src/cli.ts"], { encoding: "utf8" });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Usage:/);
  const nested = spawnSync(process.execPath, [script, "src/cli/output.ts"], {
    encoding: "utf8", env: { ...process.env, HEAVY_SLOT: "existing-test-admission", HEAVY_CPUS: "2" },
  });
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /HEAVY_CPUS/);
  assert.doesNotMatch(nested.stderr, /ProjectReader|Instrumenter/);
});

test("rejects unknown targets, globs, traversal, schemas, and missing CPU admission", () => {
  for (const target of [undefined, "", "src/**/*.ts", "../src/cli/output.ts", "/src/cli/output.ts", "src/cli.ts", "templates/prd.schema.json", "src/cli/output.ts:1-4"]) {
    assert.throws(() => mutationOptions(target, { HEAVY_CPUS: "8" }), /Unsupported mutation target/);
  }
  for (const cpus of [undefined, "", "0", "7", "8x", "NaN", "1.5"]) {
    assert.throws(() => mutationOptions("src/cli/output.ts", { HEAVY_CPUS: cpus }), /HEAVY_CPUS/);
  }
});
