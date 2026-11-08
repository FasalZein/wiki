import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Isolate synchronous parser regressions so malformed input cannot hang the suite.
/** @param {string} source */
function parseInChild(source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr);
}

test("TOML rejects the GHSA-7w5x-hrqm-74c2 unterminated comment without hanging", () => {
  parseInChild(
    'import { parse, TomlError } from "smol-toml"; import assert from "node:assert/strict";' +
    'assert.throws(() => parse("a=[1 #"), TomlError);',
  );
});

test("TOML handles the GHSA-r4xh-jqrq-34v2 dot-free key shape within a bounded child", () => {
  parseInChild(
    'import { parse } from "smol-toml"; import assert from "node:assert/strict";' +
    'let doc = ""; for (let i = 0; i < 32000; i++) doc += "k" + i + " = 1" + String.fromCharCode(10);' +
    'const parsed = parse(doc); assert.equal(Object.keys(parsed).length, 32000);' +
    'assert.equal(parsed.k0, 1); assert.equal(parsed.k31999, 1);',
  );
});
