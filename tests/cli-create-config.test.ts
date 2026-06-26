import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";

let vaultRoot: string;
let prevVaultRoot: string | undefined;
let prevQmd: string | undefined;

// The default folders assertProjectStructure still checks (config/project is
// converted in a later slice); the custom folder is what the per-vault config
// routes prd output into.
const DEFAULT_FOLDERS = ["prds", "slices", "adrs", "handoffs", "docs", "sessions"];

function capture(): { restore: () => void; out: () => string; err: () => string } {
  const ol = console.log;
  const oe = console.error;
  let o = "";
  let e = "";
  console.log = (...a: unknown[]) => { o += a.map(String).join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { e += a.map(String).join(" ") + "\n"; };
  return { restore: () => { console.log = ol; console.error = oe; }, out: () => o, err: () => e };
}

async function setupVault(wikiJson: string, extraFolders: string[]): Promise<void> {
  const proj = join(vaultRoot, "projects", "p");
  for (const f of [...DEFAULT_FOLDERS, ...extraFolders]) await mkdir(join(proj, f), { recursive: true });
  await writeFile(join(proj, "_project.md"), "---\nproject: p\nrepo: /tmp/p\ntest_command: bun test\n---\n", "utf8");
  await writeFile(join(vaultRoot, "wiki.json"), wikiJson, "utf8");
}

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "wiki-createcfg-"));
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

describe("create honors the per-vault Structure (write path)", () => {
  test("a custom wiki.json folder changes where create writes", async () => {
    await setupVault(
      JSON.stringify({
        kinds: {
          prd: { prefix: "PRD", folder: "requirements", dedup: true },
          slice: { prefix: "SLICE", folder: "slices", dedup: true },
          decision: { prefix: "ADR", folder: "adrs", dedup: false },
          doc: { prefix: "DOC", folder: "docs", dedup: false },
          handoff: { prefix: "HANDOFF", folder: "handoffs", dedup: false },
        },
      }),
      ["requirements"],
    );
    const cap = capture();
    const result = await dispatch(["create", "prd", "--project", "p", "--title", "Custom config requirement", "--summary", "Custom config requirement summary."]);
    cap.restore();
    expect(result.code).toBe(0);
    const all = cap.out() + cap.err();
    expect(all).toContain("projects/p/requirements/PRD-0001");
    const written = await readdir(join(vaultRoot, "projects", "p", "requirements"));
    expect(written.some((f) => f.startsWith("PRD-0001"))).toBe(true);
    // The default folder is untouched — the write was routed by the per-vault config.
    const defaultFolder = await readdir(join(vaultRoot, "projects", "p", "prds"));
    expect(defaultFolder.length).toBe(0);
  });

  test("a vault with no wiki.json writes today's default prefix and folder", async () => {
    const proj = join(vaultRoot, "projects", "p");
    for (const f of DEFAULT_FOLDERS) await mkdir(join(proj, f), { recursive: true });
    await writeFile(join(proj, "_project.md"), "---\nproject: p\nrepo: /tmp/p\ntest_command: bun test\n---\n", "utf8");
    const cap = capture();
    const result = await dispatch(["create", "prd", "--project", "p", "--title", "Default config requirement", "--summary", "Default config requirement summary."]);
    cap.restore();
    expect(result.code).toBe(0);
    const all = cap.out() + cap.err();
    expect(all).toContain("projects/p/prds/PRD-0001");
  });
});
