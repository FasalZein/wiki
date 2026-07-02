import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";
import { renderDraft } from "../src/cli/verbs/draft";
import { captureArtifact } from "../src/artifacts/capture";

// BUG-0001 (every create error carries its own fix) + ADR-0046 (file-first
// authoring). A temp vault with a dedup-free wiki.json so nothing shells out to qmd;
// the bundled handoff/decision templates back the two kinds.
const wikiJson = JSON.stringify({
  kinds: {
    handoff: { prefix: "HANDOFF", folder: "handoffs", dedup: false },
    decision: { prefix: "ADR", folder: "adrs", dedup: false },
  },
});

let vaultRoot: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  vaultRoot = await mkdtemp(join(tmpdir(), "wiki-bug0001-"));
  await mkdir(join(vaultRoot, "projects", "demo", "handoffs"), { recursive: true });
  await mkdir(join(vaultRoot, "projects", "demo", "adrs"), { recursive: true });
  await writeFile(join(vaultRoot, "wiki.json"), wikiJson);
  await writeFile(join(vaultRoot, "projects", "demo", "_project.md"), "---\nproject: demo\n---\n# demo\n");
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) if (value !== undefined) process.env[key] = value;
  await rm(vaultRoot, { recursive: true, force: true });
});

function capture(): { restore: () => void; out: () => string; err: () => string } {
  const ol = console.log;
  const oe = console.error;
  let o = "";
  let e = "";
  console.log = (...a: unknown[]) => { o += a.map(String).join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { e += a.map(String).join(" ") + "\n"; };
  return { restore: () => { console.log = ol; console.error = oe; }, out: () => o, err: () => e };
}

const HANDOFF_ENUM = ["plan", "prd", "slice", "handoff", "ad-hoc"];

describe("BUG-0001: create errors speak CLI language", () => {
  test("create handoff without --phase names the flag AND all five enum values", async () => {
    const cap = capture();
    const result = await dispatch(["create", "handoff", "--project", "demo", "--title", "A real title", "--summary", "A ten-char-plus summary."]);
    cap.restore();
    expect(result.code).toBe(1);
    const err = cap.err();
    expect(err).toContain("--phase");
    for (const value of HANDOFF_ENUM) expect(err).toContain(value);
  });

  test("--session-date (an auto field) is rejected with 'set automatically — omit it'", async () => {
    const cap = capture();
    const result = await dispatch([
      "create", "handoff", "--project", "demo", "--title", "A real title", "--summary", "A ten-char-plus summary.",
      "--status", "accepted", "--session-date", "2026-01-01",
    ]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("set automatically");
    expect(cap.err()).toContain("--session-date");
  });

  test("a truly-absent flag keeps 'no field' and points at wiki schema", async () => {
    const cap = capture();
    const result = await dispatch(["create", "handoff", "--project", "demo", "--title", "A real title", "--bogus", "x"]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("handoff has no field: bogus");
    expect(cap.err()).toContain("wiki schema handoff");
  });

  test("create handoff --help prints the flags block with --phase enum inline", async () => {
    const cap = capture();
    const result = await dispatch(["create", "handoff", "--help"]);
    cap.restore();
    expect(result.code).toBe(0);
    expect(cap.out()).toContain("--phase <plan|prd|slice|handoff|ad-hoc>");
  });

  test("schema handoff marks session_date as auto, not required", async () => {
    const cap = capture();
    const result = await dispatch(["schema", "handoff"]);
    cap.restore();
    expect(result.code).toBe(0);
    const line = cap.out().split("\n").find((l) => l.includes("session_date")) ?? "";
    expect(line).toContain("auto — omit at create");
    expect(line).not.toContain("required");
  });
});

describe("ADR-0046: wiki draft skeletons", () => {
  test("draft handoff, filled programmatically, is captured by the vault", async () => {
    let skeleton = await renderDraft("handoff", { project: "demo", title: "Session headline" });
    // Fill the bare required fields the skeleton left for the author.
    skeleton = skeleton
      .replace(/^summary:.*$/m, "summary: A summary of at least ten characters.")
      .replace(/^phase:.*$/m, "phase: handoff");

    const dir = await mkdtemp(join(tmpdir(), "wiki-draft-src-"));
    const draftPath = join(dir, "draft.md");
    await writeFile(draftPath, skeleton);

    const outcome = await captureArtifact({ path: draftPath, cwd: dir });
    expect(outcome?.outcome).toBe("captured");
    const handoffs = await readdir(join(vaultRoot, "projects", "demo", "handoffs"));
    expect(handoffs.filter((f) => f.endsWith(".md"))).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("draft decision contains the Context/Decision/Consequences authorable sections", async () => {
    const skeleton = await renderDraft("decision", { project: "demo" });
    expect(skeleton).toContain("## Context");
    expect(skeleton).toContain("## Decision");
    expect(skeleton).toContain("## Consequences");
    expect(skeleton).toContain("template: decision");
  });
});

describe("ADR-0046: wiki file", () => {
  test("wiki file on a stamped draft creates the artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiki-file-src-"));
    const draftPath = join(dir, "draft.md");
    await writeFile(
      draftPath,
      "---\ntemplate: handoff\nproject: demo\ntitle: Filed via wiki file\nsummary: A summary of at least ten characters.\nphase: handoff\n---\n# Filed via wiki file\n\n## What this session produced\n\nstuff\n",
    );

    const cap = capture();
    const result = await dispatch(["file", draftPath]);
    cap.restore();
    expect(result.code).toBe(0);
    expect(cap.out().trim()).toMatch(/^HANDOFF-\d+$/);
    const handoffs = await readdir(join(vaultRoot, "projects", "demo", "handoffs"));
    expect(handoffs.filter((f) => f.endsWith(".md"))).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("wiki file on an unstamped file exits 1 with a warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiki-file-src-"));
    const notArtifact = join(dir, "note.md");
    await writeFile(notArtifact, "---\ntitle: Just a note\n---\n# Just a note\n");

    const cap = capture();
    const result = await dispatch(["file", notArtifact]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("not a wiki draft");
    await rm(dir, { recursive: true, force: true });
  });
});
