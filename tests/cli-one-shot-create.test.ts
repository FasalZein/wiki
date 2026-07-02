import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("one-shot create with --body", () => {
  test("prd create --body - fills authored sections from stdin", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const body = [
      "## Problem Statement",
      "",
      "Agents bypass the CLI.",
      "",
      "## Solution",
      "",
      "One-shot creation.",
      "",
      "## User Stories",
      "",
      "1. As an agent, I want one command.",
    ].join("\n");

    const result = await runWiki(
      ["create", "prd", "--title", "One-shot authoring", "--summary", "One-shot authoring of artifacts.", "--project", "wiki-v2", "--body", "-"],
      vaultRoot,
      body,
    );

    expect(result.exitCode).toBe(0);
    const file = await readArtifactFile(vaultRoot, "prds", "PRD-0001");
    const content = matter(file).content;
    expect(content).toContain("## Problem Statement\n\nAgents bypass the CLI.");
    expect(content).toContain("## Solution\n\nOne-shot creation.");
    expect(content).toContain("1. As an agent, I want one command.");
    expect(content).not.toContain("{{");
    // guidance blockquote under a filled section is stripped
    expect(content).not.toContain("> The problem the user is facing");
    // body sections must not leak into frontmatter
    expect(matter(file).data.problem_statement).toBeUndefined();
  });

  test("slice create --acceptance and --body - is gate-ready in one command", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);

    const result = await runWiki(
      [
        "create", "slice",
        "--title", "Build the parser",
        "--summary", "Build the body section parser.",
        "--project", "wiki-v2",
        "--parent-prd", "PRD-0001",
        "--acceptance", "parser maps headings to placeholders",
        "--acceptance", "machine-owned headings are rejected",
        "--body", "-",
      ],
      vaultRoot,
      "## What to build\n\nA body parser for one-shot creation.\n",
    );

    expect(result.exitCode).toBe(0);
    const file = await readArtifactFile(vaultRoot, "slices", "SLICE-0001");
    const parsed = matter(file);
    expect(parsed.data.acceptance).toEqual([
      "parser maps headings to placeholders",
      "machine-owned headings are rejected",
    ]);
    expect(parsed.content).toContain("## What to build\n\nA body parser for one-shot creation.");
    expect(parsed.content).toContain("- [ ] parser maps headings to placeholders");
    expect(parsed.content).toContain("- [ ] machine-owned headings are rejected");
    expect(parsed.content).not.toContain("{{");
  });

  test("research create --body - fills the Content section", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      ["create", "research", "--title", "Research findings", "--summary", "The research findings summary.", "--project", "wiki-v2", "--body", "-"],
      vaultRoot,
      "## Content\n\nThe findings are extensive.\n",
    );

    expect(result.exitCode).toBe(0);
    const file = await readArtifactFile(vaultRoot, "research", "RES-0001");
    expect(matter(file).content).toContain("The findings are extensive.");
    expect(matter(file).content).not.toContain("{{");
  });

  test("a machine-owned heading in --body fails the create, naming the heading", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await seedPrd(vaultRoot);

    const result = await runWiki(
      ["create", "slice", "--title", "Build the parser", "--project", "wiki-v2", "--parent-prd", "PRD-0001", "--body", "-"],
      vaultRoot,
      "## What to build\n\nx\n\n## Todo\n\n- [ ] mine\n",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("## Todo");
    expect(result.stderr).toContain("machine-owned");
    const slices = await readdir(join(vaultRoot, "projects", "wiki-v2", "slices"));
    expect(slices).toEqual([]);
  });

  test("an unknown heading in --body fails the create, listing expected sections", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      ["create", "prd", "--title", "One-shot authoring", "--project", "wiki-v2", "--body", "-"],
      vaultRoot,
      "## Wild Ideas\n\nx\n",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("## Wild Ideas");
    expect(result.stderr).toContain("## Problem Statement");
  });
});

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runWiki(args: string[], vaultRoot: string, stdin?: string): Promise<CommandResult> {
  const repoRoot = import.meta.dir.replace(/\/tests$/, "");
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot },
    stdin: stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function seedPrd(vaultRoot: string): Promise<void> {
  const result = await runWiki(["create", "prd", "--title", "Core wiki CLI", "--summary", "The core wiki CLI surface.", "--project", "wiki-v2"], vaultRoot);
  expect(result.exitCode).toBe(0);
}

async function createFixtureVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  for (const dir of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(projectPath, dir), { recursive: true });
  }
  const qmdCommand = join(vaultRoot, "fake-qmd");
  await writeFile(qmdCommand, "#!/usr/bin/env bash\nset -euo pipefail\ncase \"${1:-}\" in\n  collection) exit 0 ;;\n  query) echo '[]' ;;\nesac\n");
  await chmod(qmdCommand, 0o755);
  await writeFile(join(projectPath, "_project.md"), `---\nqmd_command: ${qmdCommand}\n---\n# ${project}\n`);
  return vaultRoot;
}

async function readArtifactFile(vaultRoot: string, folder: string, id: string): Promise<string> {
  const dir = join(vaultRoot, "projects", "wiki-v2", folder);
  const files = await readdir(dir);
  const match = files.find((f) => f.startsWith(id));
  expect(match).toBeDefined();
  return readFile(join(dir, match as string), "utf8");
}
