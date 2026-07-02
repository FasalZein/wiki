import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";

let vaultRoot: string;
let prevVaultRoot: string | undefined;
let prevQmd: string | undefined;

const ARTIFACT_FOLDERS = ["prds", "slices", "adrs", "handoffs", "docs"];

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "wiki-bleed-"));
  const proj = join(vaultRoot, "projects", "p");
  for (const f of ARTIFACT_FOLDERS) await mkdir(join(proj, f), { recursive: true });
  await writeFile(join(proj, "_project.md"), "---\nproject: p\nrepo: /tmp/p\ntest_command: bun test\n---\n", "utf8");
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  const qmd = join(vaultRoot, "fake-qmd");
  await writeFile(qmd, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  prevQmd = process.env.QMD_COMMAND;
  process.env.QMD_COMMAND = qmd;
});

afterEach(async () => {
  if (prevVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = prevVaultRoot;
  if (prevQmd === undefined) delete process.env.QMD_COMMAND;
  else process.env.QMD_COMMAND = prevQmd;
  await rm(vaultRoot, { recursive: true, force: true });
});

// All five created artifacts must be free of Templater/INPUT/guidance bleed (SLICE-0074).
async function readArtifact(folder: string): Promise<string> {
  const dir = join(vaultRoot, "projects", "p", folder);
  const file = (await readdir(dir)).find((f) => f.endsWith(".md"));
  if (file === undefined) throw new Error(`no artifact written in ${dir}`);
  return readFile(join(dir, file), "utf8");
}

describe("templates carry no bleed markers (SLICE-0074)", () => {
  const creates: [string, string[]][] = [
    ["prds", ["create", "prd", "--project", "p", "--title", "Some requirement", "--summary", "A requirement summary line."]],
    ["slices", ["create", "slice", "--project", "p", "--title", "Some slice", "--summary", "A slice summary line."]],
    ["adrs", ["create", "decision", "--project", "p", "--title", "Some decision", "--summary", "A decision summary line."]],
    ["runbooks", ["create", "runbooks", "--project", "p", "--title", "Some runbook", "--summary", "A runbook summary line."]],
    ["handoffs", ["create", "handoff", "--project", "p", "--phase", "plan", "--title", "Session handoff", "--summary", "A handoff summary line."]],
  ];

  for (const [folder, args] of creates) {
    test(`create ${args[1]} writes no INPUT/Templater/guidance bleed`, async () => {
      expect((await dispatch(args)).code).toBe(0);
      const file = await readArtifact(folder);
      expect(file).not.toContain("INPUT[select");
      expect(file).not.toContain("<%*");
      // no instructional blockquotes leaked into the body
      const body = file.split("\n---\n")[1] ?? file;
      expect(body).not.toMatch(/^>.*(perspective|implementation|deliberately|automatically|Redact|gated)/m);
    });
  }
});
