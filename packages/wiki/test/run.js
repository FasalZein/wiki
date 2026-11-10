// Keep the name-pattern option before file arguments so affected runs stay affected.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const files = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.ts"))
  .sort().map((name) => fileURLToPath(new URL(name, import.meta.url)));
// --all (verify:next, the batch gate) runs every test even when WIKI_TEST_PATTERN is set, so a leaked
// variable cannot turn the gate into a subset run. test:wiki honors the pattern.
const pattern = process.argv.includes("--all") ? undefined : process.env.WIKI_TEST_PATTERN;
// The one test-file concurrency value: test:wiki and verify:next both run this script. Each file is
// one Node process; most tests run commands inside it. Keep this value at twice the heavy slots that
// docs/wiki-foundation.md tells callers to claim.
const FILE_CONCURRENCY = 4;
// A pattern run also counts the tests that ran, so a pattern that matches nothing fails instead of passing.
const scratch = pattern ? mkdtempSync(join(tmpdir(), "wiki-test-run-")) : undefined;
const counted = scratch ? join(scratch, "ran") : undefined;
const reporters = counted ? ["--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=" + fileURLToPath(new URL("ran-reporter.js", import.meta.url)), "--test-reporter-destination=" + counted] : [];
try {
  const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${FILE_CONCURRENCY}`, ...reporters, ...(pattern ? ["--test-name-pattern", pattern] : []), ...files], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0 && counted) {
    let ran = 0;
    try { ran = Number(readFileSync(counted, "utf8").trim()) || 0; } catch { /* No count: treat as no test ran. */ }
    if (ran === 0) {
      process.stderr.write("WIKI_TEST_PATTERN matched no test; no test ran: " + JSON.stringify(pattern) + "\n");
      process.exitCode = 1;
    }
  } else process.exitCode = result.status ?? 1;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
