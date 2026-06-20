import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";

let vaultRoot: string;
let prevVaultRoot: string | undefined;

const ARTIFACT_FOLDERS = ["prds", "slices", "adrs", "handovers", "docs"];

async function makeProject(name: string, frontmatter: string): Promise<void> {
  const dir = join(vaultRoot, "projects", name);
  for (const f of ARTIFACT_FOLDERS) await mkdir(join(dir, f), { recursive: true });
  await writeFile(join(dir, "_project.md"), frontmatter, "utf8");
}

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
  vaultRoot = await mkdtemp(join(tmpdir(), "wiki-err-"));
  await mkdir(join(vaultRoot, "projects"), { recursive: true });
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
});

afterEach(async () => {
  if (prevVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = prevVaultRoot;
  await rm(vaultRoot, { recursive: true, force: true });
});

describe("actionable unknown-subverb errors", () => {
  test("unknown session subverb lists the valid subverbs", async () => {
    const cap = capture();
    const result = await dispatch(["session", "bogus"]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("start");
    expect(cap.err()).toContain("show");
  });

  test("unknown vault action lists the valid actions", async () => {
    const cap = capture();
    const result = await dispatch(["vault", "bogus"]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("init");
    expect(cap.err()).toContain("doctor");
  });

  test("unknown project subverb lists the valid subverbs", async () => {
    const cap = capture();
    const result = await dispatch(["project", "bogus"]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("create");
  });

  test("unknown doc subverb lists the valid subverbs", async () => {
    const cap = capture();
    const result = await dispatch(["doc", "bogus"]);
    cap.restore();
    expect(result.code).toBe(1);
    expect(cap.err()).toContain("retitle");
    expect(cap.err()).toContain("recategorize");
  });
});

describe("actionable project errors", () => {
  test("status on a nonexistent project suggests wiki project create and lists available", async () => {
    await makeProject("alpha", "---\nproject: alpha\nrepo: /tmp/a\ntest_command: bun test\n---\n");
    const cap = capture();
    const result = await dispatch(["status", "--project", "ghost"]);
    cap.restore();
    expect(result.code).not.toBe(0);
    const msg = cap.err() + cap.out();
    expect(msg).toContain("wiki project create");
    expect(msg).toContain("ghost");
    expect(msg).toContain("alpha"); // available projects listed
  });

  test("search on a nonexistent project suggests create instead of a cryptic error", async () => {
    await makeProject("alpha", "---\nproject: alpha\nrepo: /tmp/a\ntest_command: bun test\n---\n");
    const cap = capture();
    const result = await dispatch(["search", "anything", "--project", "ghost"]);
    cap.restore();
    expect(result.code).not.toBe(0);
    const msg = cap.err() + cap.out();
    expect(msg).toContain("wiki project create");
  });
});
