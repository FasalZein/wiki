// Keep the name-pattern option before file arguments so affected runs stay affected.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const files = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.ts"))
  .sort().map((name) => fileURLToPath(new URL(name, import.meta.url)));
const pattern = process.env.WIKI_TEST_PATTERN;
// The one test-file concurrency value: test:wiki and verify:next both run this script. Most
// tests start one CLI process at a time. Keep this value at twice the heavy slots that
// docs/wiki-foundation.md tells callers to claim.
const FILE_CONCURRENCY = 4;
const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${FILE_CONCURRENCY}`, ...(pattern ? ["--test-name-pattern", pattern] : []), ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
