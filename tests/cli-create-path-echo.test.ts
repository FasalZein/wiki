import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";

let vaultRoot: string;
let prevVaultRoot: string | undefined;
let prevQmd: string | undefined;

const ARTIFACT_FOLDERS = ["prds", "slices", "adrs", "handovers", "docs", "sessions"];

function capture(): { restore: () => void; out: () => string; err: () => string } {
  const ol = console.log;
  const oe = console.error;
  let o = "";
  let e = "";
  console.log = (...a: unknown[]) => { o += a.map(String).join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { e += a.map(String).join(" ") + "\n"; };
  return { restore: () => { console.log = ol; console.error = oe; }, out: () => o, err: () => e };
}

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "wiki-pathecho-"));
  const proj = join(vaultRoot, "projects", "p");
  for (const f of ARTIFACT_FOLDERS) await mkdir(join(proj, f), { recursive: true });
  await writeFile(join(proj, "_project.md"), "---\nproject: p\nrepo: /tmp/p\ntest_command: bun test\n---\n", "utf8");
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  // Hermetic dedup gate: a no-op qmd so these output-shape tests don't ride the
  // real binary's ~5s embedding-model cold start (flaky against bun's 5s timeout).
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

describe("create echoes destination path", () => {
  test("create prd prints the vault-relative path it wrote", async () => {
    const cap = capture();
    const result = await dispatch(["create", "prd", "--project", "p", "--title", "Some new requirement doc"]);
    cap.restore();
    expect(result.code).toBe(0);
    const all = cap.out() + cap.err();
    expect(all).toContain("projects/p/prds/PRD-0001");
    expect(all).toMatch(/PRD-0001-[a-z0-9-]+\.md/);
  });

  test("create doc prints the docs/<category>/ path", async () => {
    const cap = capture();
    const result = await dispatch(["create", "doc", "--project", "p", "--title", "Deploy runbook for prod", "--type", "runbook"]);
    cap.restore();
    expect(result.code).toBe(0);
    const all = cap.out() + cap.err();
    expect(all).toContain("projects/p/docs/runbooks/DOC-0001");
  });

  test("create handover works through the generic config-driven path (ADR-0035)", async () => {
    // handover never had a bespoke create fn; it is creatable purely from its
    // wiki.json entry + template, proving the full collapse needs no per-kind code.
    const cap = capture();
    const result = await dispatch(["create", "handover", "--project", "p", "--phase", "plan"]);
    cap.restore();
    expect(result.code).toBe(0);
    const all = cap.out() + cap.err();
    expect(all).toContain("projects/p/handovers/HANDOVER-0001");
  });
});
