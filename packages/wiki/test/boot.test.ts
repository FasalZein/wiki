import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BOOT = fileURLToPath(new URL("../scripts/boot.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-boot-test-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
function boot(tmpdir: string) {
  return spawnSync(process.execPath, [BOOT], { encoding: "utf8", env: { ...process.env, TMPDIR: tmpdir }, timeout: 120_000 });
}

test("wiki:20 boot runs every foundation step against the source CLI and removes its temporary state", () => {
  const root = path.join(temp, "ok");
  fs.mkdirSync(root);
  const result = boot(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const steps = [...result.stdout.matchAll(/^boot step (.*)$/gm)].map((m) => JSON.parse(m[1]!));
  assert.deepEqual(steps, [
    { step: "init", exit: 0 }, { step: "type list", exit: 0 }, { step: "lint", exit: 0 }, { step: "new", exit: 0 },
    { step: "show", exit: 0 }, { step: "update stale digest refused", exit: 3 }, { step: "index check", exit: 0 },
  ]);
  assert.match(result.stdout, /"bin":"[^"]*packages\/wiki\/bin\/wiki\.js"/);
  assert.match(result.stdout, /"removed":true/);
  assert.match(result.stdout, /^boot: OK$/m);
  assert.deepEqual(fs.readdirSync(root), [], "Boot left entries in its temporary root");
});

test("wiki:20 boot exits nonzero when it cannot complete", () => {
  const result = boot(path.join(temp, "missing"));
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /boot: OK/);
});
