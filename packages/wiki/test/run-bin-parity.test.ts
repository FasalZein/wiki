// run() and the real bin/wiki.js must produce the same exit code, stdout and stderr for the same command.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { runCli, spawnCli } from "./cli-helper.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-parity-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test("wiki:S9 run() and bin/wiki.js agree on exit code, stdout and stderr for sample commands", async () => {
  const vault = path.join(temp, "vault");
  assert.equal(spawnCli(["--json", "init", vault]).status, 0);
  const env = { HOME: temp };
  const samples: string[][] = [];
  for (const json of [["--json"], []]) samples.push(
    ["--help", ...json],
    ["--bogus", ...json],
    ["lint", ...json],
    ["--vault", vault, "type", "list", ...json],
    ["--vault", vault, "lint", ...json],
    ["--vault", vault, "index", "--check", ...json],
    ["--vault", vault, "show", "personal/notes/none.md", ...json],
    ["--vault", vault, "new", "nosuch", "--personal", "--title", "T", "--description", "D", ...json],
    ["--vault", vault, "find", "q", "--limit", "0", ...json],
    ["--vault", vault, "update", "personal/notes/x.md", "--expect", "sha256:00", "--file", "x", ...json],
  );
  for (const args of samples) {
    const inProcess = await runCli(args, { env });
    const real = spawnCli(args, { env });
    assert.deepEqual({ status: real.status, stdout: real.stdout, stderr: real.stderr }, inProcess, args.join(" "));
  }
});
