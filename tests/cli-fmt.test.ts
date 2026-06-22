import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const DIRTY_SLICE = `---
id: SLICE-0001
title: Test slice
project: wiki-v2
status: open
created: 2026-05-25T00:00:00.000Z
updated: 2026-05-26
---

## What to build

Test.
`;

const CLEAN_SLICE = `---
id: SLICE-0002
aliases:
  - SLICE-0002
title: Clean slice
project: wiki-v2
status: open
created: '2026-05-25'
updated: '2026-05-26'
---
## What to build

Already canonical.
`;

describe("fmt CLI", () => {
  test("check mode lists date violations as file + field + canonical form and exits 1", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0001-test-slice.md", DIRTY_SLICE);
    await writeSlice(vaultRoot, "SLICE-0002-clean-slice.md", CLEAN_SLICE);

    const result = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("SLICE-0001-test-slice.md");
    expect(result.stdout).toContain("created");
    expect(result.stdout).toContain("'2026-05-25'");
    expect(result.stdout).toContain("updated");
    expect(result.stdout).toContain("'2026-05-26'");
    // already-canonical file produces no violation
    expect(result.stdout).not.toContain("SLICE-0002-clean-slice.md");
  });

  test("a nonexistent --project exits 10 with the available-projects listing", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["fmt", "--project", "does-not-exist"], vaultRoot);

    expect(result.exitCode).toBe(10);
    expect(result.stderr).toContain("wiki-v2");
  });

  test("--write normalizes date fields to quoted YYYY-MM-DD and exits 0", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0001-test-slice.md", DIRTY_SLICE);

    const result = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(result.exitCode).toBe(0);
    const content = await readFile(slicePath(vaultRoot, "SLICE-0001-test-slice.md"), "utf8");
    expect(content).toContain("created: '2026-05-25'");
    expect(content).toContain("updated: '2026-05-26'");
    expect(content).not.toContain("T00:00:00.000Z");
    // body untouched
    expect(content).toContain("## What to build");
  });

  test("a second run after --write reports clean and exits 0 (idempotent)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0001-test-slice.md", DIRTY_SLICE);

    await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);
    const check = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    const rewrite = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(check.exitCode).toBe(0);
    expect(check.stdout).toContain("clean");
    expect(rewrite.exitCode).toBe(0);
    expect(rewrite.stdout).toContain("clean");
  });

  // --- SLICE-0058: body fixes ---

  const TEMPLATER_SLICE = `---
id: SLICE-0003
title: Templater leak
project: wiki-v2
status: open
created: '2026-05-25'
updated: '2026-05-25'
---
<!--
<%*
// Only runs when created via Templater in Obsidian
const title = await tp.system.prompt("Title");
-%>
-->

## What to build

Something.
`;

  test("--write strips Templater comment blocks from bodies (SLICE-0058)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0003-templater-leak.md", TEMPLATER_SLICE);

    const check = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(check.exitCode).toBe(1);
    expect(check.stdout.toLowerCase()).toContain("templater");

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);
    expect(write.exitCode).toBe(0);
    const content = await readFile(slicePath(vaultRoot, "SLICE-0003-templater-leak.md"), "utf8");
    expect(content).not.toContain("<%*");
    expect(content).not.toContain("tp.system.prompt");
    expect(content).toContain("## What to build");

    const recheck = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(recheck.exitCode).toBe(0);
  });

  const UNRENDERED_ACCEPTANCE_SLICE = `---
id: SLICE-0004
title: Unrendered acceptance
project: wiki-v2
status: open
acceptance:
  - First criterion
  - Second criterion
created: '2026-05-25'
updated: '2026-05-25'
---

## Acceptance criteria

{{#each acceptance}}- [ ] {{this}}
{{/each}}

## What to build

Something.
`;

  test("--write expands a literal {{#each acceptance}} block into checkboxes (SLICE-0058)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0004-unrendered-acceptance.md", UNRENDERED_ACCEPTANCE_SLICE);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    const content = await readFile(slicePath(vaultRoot, "SLICE-0004-unrendered-acceptance.md"), "utf8");
    expect(content).toContain("- [ ] First criterion");
    expect(content).toContain("- [ ] Second criterion");
    expect(content).not.toContain("{{#each");
    expect(content).not.toContain("{{this}}");
  });

  const CLOSED_TODO_SLICE = `---
id: SLICE-0005
title: Closed with todos
project: wiki-v2
status: closed
created: '2026-05-25'
updated: '2026-05-25'
---

## Todo

- [ ] Write tests
- [x] Implement feature

## What to build

Something with - [ ] outside the Todo section.
`;

  const OPEN_TODO_SLICE = CLOSED_TODO_SLICE.replace("status: closed", "status: open").replace("SLICE-0005", "SLICE-0006").replace("Closed with todos", "Open with todos");

  test("--write ticks Todo checkboxes only in closed slices (SLICE-0058)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0005-closed-with-todos.md", CLOSED_TODO_SLICE);
    await writeSlice(vaultRoot, "SLICE-0006-open-with-todos.md", OPEN_TODO_SLICE);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    const closed = await readFile(slicePath(vaultRoot, "SLICE-0005-closed-with-todos.md"), "utf8");
    expect(closed).toContain("- [x] Write tests");
    // checkbox-looking text outside the Todo section stays untouched
    expect(closed).toContain("Something with - [ ] outside the Todo section.");
    const open = await readFile(slicePath(vaultRoot, "SLICE-0006-open-with-todos.md"), "utf8");
    expect(open).toContain("- [ ] Write tests");
  });

  test("artifact creation strips the Templater block for every type (SLICE-0058)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const prd = await runWiki(
      ["create", "prd", "--project", "wiki-v2", "--title", "No templater leak", "--force-new", "fixture vault has no qmd so dedup is skipped anyway"],
      vaultRoot,
    );
    expect(prd.exitCode).toBe(0);
    const files = await readdir(join(vaultRoot, "projects", "wiki-v2", "prds"));
    const prdFile = files.find((name) => name.startsWith("PRD-0001"));
    expect(prdFile).toBeDefined();
    const content = await readFile(join(vaultRoot, "projects", "wiki-v2", "prds", prdFile ?? ""), "utf8");
    expect(content).not.toContain("<%*");
    expect(content).not.toContain("tp.system.prompt");
  });

  // --- SLICE-0059: frontmatter shape ---

  test("created artifacts declare aliases and put id first (SLICE-0059)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const prd = await runWiki(
      ["create", "prd", "--project", "wiki-v2", "--title", "Aliases and order", "--force-new", "fixture vault has no qmd so dedup is skipped anyway"],
      vaultRoot,
    );
    expect(prd.exitCode).toBe(0);
    const files = await readdir(join(vaultRoot, "projects", "wiki-v2", "prds"));
    const content = await readFile(join(vaultRoot, "projects", "wiki-v2", "prds", files[0] ?? ""), "utf8");
    expect(content.split("\n")[1]).toBe("id: PRD-0001");
    expect(content).toContain("aliases:\n  - PRD-0001");
  });

  test("--write backfills aliases where missing (SLICE-0059)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const noAliases = CLEAN_SLICE.replace("aliases:\n  - SLICE-0002\n", "");
    await writeSlice(vaultRoot, "SLICE-0002-clean-slice.md", noAliases);

    const check = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain("aliases");

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);
    expect(write.exitCode).toBe(0);
    const content = await readFile(slicePath(vaultRoot, "SLICE-0002-clean-slice.md"), "utf8");
    expect(content).toContain("aliases:\n  - SLICE-0002");

    const recheck = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(recheck.exitCode).toBe(0);
  });

  const DISORDERED_SLICE = `---
title: Title before id
aliases:
  - SLICE-0007
todo: legacy field
id: SLICE-0007
project: wiki-v2
status: open
created: '2026-05-25'
updated: '2026-05-25'
---
## What to build

Disordered.
`;

  test("--write reorders frontmatter to schema order and preserves unknown fields (SLICE-0059)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0007-title-before-id.md", DISORDERED_SLICE);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    const content = await readFile(slicePath(vaultRoot, "SLICE-0007-title-before-id.md"), "utf8");
    const lines = content.split("\n");
    expect(lines[1]).toBe("id: SLICE-0007");
    expect(content).toContain("todo: legacy field");
    expect(content.indexOf("todo:")).toBeGreaterThan(content.indexOf("updated:"));

    const recheck = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(recheck.exitCode).toBe(0);
  });

  test("already-canonical files produce no diff (SLICE-0059)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-0002-clean-slice.md", CLEAN_SLICE);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("clean");
    expect(await readFile(slicePath(vaultRoot, "SLICE-0002-clean-slice.md"), "utf8")).toBe(CLEAN_SLICE);
  });

  // --- SLICE-0060: ID renumbering ---

  const LEGACY_PRD = `---
id: PRD-001
aliases:
  - PRD-001
title: Legacy padded PRD
project: wiki-v2
status: closed
created: '2026-05-25'
updated: '2026-05-25'
---
## Problem Statement

Old.
`;

  const LEGACY_SLICE = `---
id: SLICE-001
aliases:
  - SLICE-001
title: Legacy padded slice
project: wiki-v2
parent_prd: PRD-001
status: closed
created: '2026-05-25'
updated: '2026-05-25'
---
## What to build

Old slice.
`;

  const REFERENCING_SLICE = `---
id: SLICE-0042
aliases:
  - SLICE-0042
title: References legacy ids
project: wiki-v2
parent_prd: PRD-001
blocked_by:
  - SLICE-001
status: open
created: '2026-05-25'
updated: '2026-05-25'
---
## What to build

Depends on SLICE-001 and PRD-001.
`;

  async function writeLegacyFixtures(vaultRoot: string): Promise<void> {
    await writeFile(join(vaultRoot, "projects", "wiki-v2", "prds", "PRD-001-legacy-padded-prd.md"), LEGACY_PRD);
    await writeSlice(vaultRoot, "SLICE-001-legacy-padded-slice.md", LEGACY_SLICE);
    await writeSlice(vaultRoot, "SLICE-0042-references-legacy-ids.md", REFERENCING_SLICE);
  }

  test("--write renames legacy 3-digit ids to 4-digit and rewrites references vault-wide (SLICE-0060)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeLegacyFixtures(vaultRoot);

    const check = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain("SLICE-001");
    expect(check.stdout).toContain("SLICE-0001");

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);
    expect(write.exitCode).toBe(0);

    const sliceFiles = await readdir(join(vaultRoot, "projects", "wiki-v2", "slices"));
    expect(sliceFiles).toContain("SLICE-0001-legacy-padded-slice.md");
    expect(sliceFiles).not.toContain("SLICE-001-legacy-padded-slice.md");
    const prdFiles = await readdir(join(vaultRoot, "projects", "wiki-v2", "prds"));
    expect(prdFiles).toContain("PRD-0001-legacy-padded-prd.md");

    const renamed = await readFile(slicePath(vaultRoot, "SLICE-0001-legacy-padded-slice.md"), "utf8");
    expect(renamed).toContain("id: SLICE-0001");
    expect(renamed).toContain("- SLICE-0001"); // alias rewritten
    expect(renamed).toContain("parent_prd: PRD-0001");

    const referencing = await readFile(slicePath(vaultRoot, "SLICE-0042-references-legacy-ids.md"), "utf8");
    expect(referencing).toContain("parent_prd: PRD-0001");
    expect(referencing).toContain("- SLICE-0001");
    expect(referencing).toContain("Depends on SLICE-0001 and PRD-0001.");
    // the 4-digit id itself is untouched
    expect(referencing).toContain("id: SLICE-0042");

    const recheck = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);
    expect(recheck.exitCode).toBe(0);
  });

  test("--write ends with an old-to-new map and a wiki sync instruction (SLICE-0060)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeLegacyFixtures(vaultRoot);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("SLICE-001 -> SLICE-0001");
    expect(write.stdout).toContain("PRD-001 -> PRD-0001");
    expect(write.stdout).toContain("wiki sync");
  });

  test("renumbering skips and flags when the padded id already exists (SLICE-0060)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await writeSlice(vaultRoot, "SLICE-001-legacy-padded-slice.md", LEGACY_SLICE.replace("parent_prd: PRD-001\n", ""));
    const occupant = CLEAN_SLICE.replaceAll("SLICE-0002", "SLICE-0001").replace("Clean slice", "Occupies the padded id");
    await writeSlice(vaultRoot, "SLICE-0001-occupies-the-padded-id.md", occupant);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    expect(write.stdout.toLowerCase()).toContain("collision");
    const sliceFiles = await readdir(join(vaultRoot, "projects", "wiki-v2", "slices"));
    expect(sliceFiles).toContain("SLICE-001-legacy-padded-slice.md");
    const legacy = await readFile(slicePath(vaultRoot, "SLICE-001-legacy-padded-slice.md"), "utf8");
    expect(legacy).toContain("id: SLICE-001");
  });

  // --- SLICE-0061: flag-only diagnostics ---

  const ADR_NARRATIVE = `---
id: ADR-0001
aliases:
  - ADR-0001
title: Narrative in frontmatter
project: wiki-v2
status: accepted
created: '2026-05-25'
updated: '2026-05-25'
context: The forces at play.
decision: The choice taken.
consequences: What follows.
---
## Context

The forces at play.
`;

  const HANDOFF_PROSE = `---
id: HANDOFF-0001
aliases:
  - HANDOFF-0001
project: wiki-v2
session_date: '2026-05-25'
phase: plan
active_slices: []
decisions_made:
  - Search is canonical term, not Retrieval
status: open
created: '2026-05-25'
---
## Produced

X.
`;

  const PRE_SCHEMA_HANDOFF = `---
handoff: 0001
project: wiki-v2
---
# Handoff

Old grilling session notes.
`;

  const GUIDANCE_ONLY_PRD = `---
id: PRD-0042
aliases:
  - PRD-0042
title: Empty draft PRD
project: wiki-v2
status: draft
created: '2026-05-25'
updated: '2026-05-25'
---
## Problem Statement

> Replace this with the actual problem.

## Solution

Real solution text.
`;

  const MISSING_STATUS_SLICE = `---
id: SLICE-0099
aliases:
  - SLICE-0099
title: No status field
project: wiki-v2
created: '2026-05-25'
updated: '2026-05-25'
---
## What to build

X.
`;

  test("check flags flag-only findings with hints and exits 1 (SLICE-0061)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const projectPath = join(vaultRoot, "projects", "wiki-v2");
    await writeFile(join(projectPath, "adrs", "ADR-0001-narrative-in-frontmatter.md"), ADR_NARRATIVE);
    await writeFile(join(projectPath, "handoffs", "HANDOFF-0001-prose-decisions.md"), HANDOFF_PROSE);
    await writeFile(join(projectPath, "handoffs", "0001-grilling-session-1.md"), PRE_SCHEMA_HANDOFF);
    await writeFile(join(projectPath, "prds", "PRD-0042-empty-draft-prd.md"), GUIDANCE_ONLY_PRD);
    await writeSlice(vaultRoot, "SLICE-0099-no-status-field.md", MISSING_STATUS_SLICE);

    const check = await runWiki(["fmt", "--project", "wiki-v2"], vaultRoot);

    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain("hint:");
    expect(check.stdout).toContain("decisions_made");
    expect(check.stdout).toContain("no id in frontmatter");
    expect(check.stdout).toContain("missing required fields: status");
    expect(check.stdout).toContain("only template guidance");
    expect(check.stdout).toContain("narrative stored in frontmatter");
    // the authored Solution section is not flagged
    expect(check.stdout).not.toContain('"Solution"');
  });

  test("--write separates fixed items from needs-manual-attention items (SLICE-0061)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const projectPath = join(vaultRoot, "projects", "wiki-v2");
    await writeFile(join(projectPath, "adrs", "ADR-0001-narrative-in-frontmatter.md"), ADR_NARRATIVE);
    await writeSlice(vaultRoot, "SLICE-0001-test-slice.md", DIRTY_SLICE);

    const write = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);

    expect(write.exitCode).toBe(0);
    expect(write.stdout).toContain("fixed");
    expect(write.stdout).toContain("needs manual attention:");
    expect(write.stdout.indexOf("needs manual attention:")).toBeGreaterThan(write.stdout.lastIndexOf("fixed "));
    // ADR narrative was not auto-converted
    const adr = await readFile(join(projectPath, "adrs", "ADR-0001-narrative-in-frontmatter.md"), "utf8");
    expect(adr).toContain("context: The forces at play.");

    const rewrite = await runWiki(["fmt", "--project", "wiki-v2", "--write"], vaultRoot);
    expect(rewrite.exitCode).toBe(0);
    expect(rewrite.stdout).toContain("needs manual attention:");
  });

  test("fmt --help documents check-default and --write semantics", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["fmt", "--help"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--write");
    expect(result.stdout.toLowerCase()).toContain("check");
  });
});

function slicePath(vaultRoot: string, filename: string): string {
  return join(vaultRoot, "projects", "wiki-v2", "slices", filename);
}

async function writeSlice(vaultRoot: string, filename: string, content: string): Promise<void> {
  await writeFile(slicePath(vaultRoot, filename), content);
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot },
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

async function createFixtureVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}
