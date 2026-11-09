// Keep the name-pattern option before file arguments so affected runs stay affected.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const files = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.ts"))
  .sort().map((name) => fileURLToPath(new URL(name, import.meta.url)));
const pattern = process.env.OKF_TEST_PATTERN;
const result = spawnSync(process.execPath, ["--test", ...(pattern ? ["--test-name-pattern", pattern] : []), ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
