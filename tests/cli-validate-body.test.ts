import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const COMPLETE_SLICE = `---
id: SLICE-0001
aliases:
  - SLICE-0001
title: Complete slice
summary: A complete slice fixture.
project: wiki-v2
parent_prd: PRD-0001
status: planned
type: AFK
acceptance:
  - one
tdd_exempt: false
created: '2026-06-26'
updated: '2026-06-26'
---
# Complete slice

## Parent

[[PRD-0001]]

## What to build

The thing.

## Acceptance criteria

- [ ] one

## Todo

- [ ] Write tests

## Blocked by

None.

## Evidence

- **Red log:**
`;

// same as complete, but the required ## What to build section was removed
const MISSING_SECTION_SLICE = COMPLETE_SLICE.replace("## What to build\n\nThe thing.\n\n", "");

describe("validate body-section check (SLICE-0087)", () => {
  test("validate fails a slice with a removed required H2 section, naming it", async () => {
    const f = await fixture();
    const path = join(f.projectPath, "slices", "SLICE-0001-x.md");
    await writeFile(path, MISSING_SECTION_SLICE);

    const result = await runWiki(["validate", path], f);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("what to build");
  });

  test("validate passes a complete slice body", async () => {
    const f = await fixture();
    const path = join(f.projectPath, "slices", "SLICE-0001-x.md");
    await writeFile(path, COMPLETE_SLICE);

    const result = await runWiki(["validate", path], f);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("valid slice");
  });

  test("fmt --check reports the same missing required section", async () => {
    const f = await fixture();
    await writeFile(join(f.projectPath, "slices", "SLICE-0001-x.md"), MISSING_SECTION_SLICE);

    const result = await runWiki(["fmt", "--project", "wiki-v2"], f);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toLowerCase()).toContain("what to build");
  });
});

describe("validate --json shape (SLICE-0088)", () => {
  test("validate --json on a clean artifact emits {ok:true,type,errors:[]}", async () => {
    const f = await fixture();
    const path = join(f.projectPath, "slices", "SLICE-0001-x.md");
    await writeFile(path, COMPLETE_SLICE);

    const result = await runWiki(["validate", path, "--json"], f);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, type: "slice", errors: [] });
  });

  test("validate --json on an invalid enum emits {ok:false,errors:[{field,reason,expected}]}", async () => {
    const f = await fixture();
    const path = join(f.projectPath, "slices", "SLICE-0001-x.md");
    await writeFile(path, COMPLETE_SLICE.replace("status: planned", "status: nope"));

    const result = await runWiki(["validate", path, "--json"], f);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.type).toBe("slice");
    const statusError = parsed.errors.find((e: { field: string }) => e.field === "status");
    expect(statusError.reason).toContain("enum");
    expect(statusError.expected).toContain("one of:");
  });

  test("validate --json reports a missing body section as a body error", async () => {
    const f = await fixture();
    const path = join(f.projectPath, "slices", "SLICE-0001-x.md");
    await writeFile(path, MISSING_SECTION_SLICE);

    const result = await runWiki(["validate", path, "--json"], f);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    const bodyError = parsed.errors.find((e: { field: string }) => e.field === "body");
    expect(bodyError.expected.toLowerCase()).toContain("what to build");
  });
});

type Fixture = { vaultRoot: string; projectPath: string; env: Record<string, string> };

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-validate-body-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", "wiki-v2");
  for (const dir of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(projectPath, dir), { recursive: true });
  }
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: /tmp/repo\ntest_command: bun test\n---\n# wiki-v2\n`);
  return { vaultRoot, projectPath, env: {} };
}

async function runWiki(args: string[], f: Fixture): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: f.vaultRoot, ...f.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
