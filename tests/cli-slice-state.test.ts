import matter from "gray-matter";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("slice TDD state machine CLI", () => {
  test("red on non-planned exits 2 and leaves the slice unchanged", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await runWiki(["slice", "set", "SLICE-0001", "--project", "wiki-v2", "--field", "status", "green"], fixture.vaultRoot);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot red SLICE-0001 from status green");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });
});

type Fixture = {
  vaultRoot: string;
  repoPath: string;
  statePath: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function createFixture(project = "wiki-v2"): Promise<Fixture> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  const repoPath = await mkdtemp(join(tmpdir(), "wiki-repo-"));
  const statePath = await mkdtemp(join(tmpdir(), "wiki-test-state-"));
  tempPaths.push(vaultRoot, repoPath, statePath);

  const scriptPath = join(repoPath, "fake-test.sh");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash\nif [ -f "$1/want-fail" ]; then\n  echo "(fake) test failed"\n  exit 1\nfi\necho "(fake) test passed"\nexit 0\n`,
  );
  await chmod(scriptPath, 0o755);

  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "decisions"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(
    join(projectPath, "_project.md"),
    `---\nproject: ${project}\nrepo: ${repoPath}\ntest_command: ${scriptPath} ${statePath}\n---\n# ${project}\n`,
  );
  await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", project], vaultRoot);
  return { vaultRoot, repoPath, statePath };
}

async function createSliceWithAcceptance(fixture: Fixture): Promise<void> {
  const create = await runWiki(
    ["slice", "create", "--title", "Build slice authoring", "--project", "wiki-v2", "--parent-prd", "PRD-0001"],
    fixture.vaultRoot,
  );
  expect(create.exitCode).toBe(0);
  const append = await runWiki(
    ["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "acceptance", "First criterion"],
    fixture.vaultRoot,
  );
  expect(append.exitCode).toBe(0);
}

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: repoRoot,
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

async function readSlice(vaultRoot: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "slices", "SLICE-0001.md"), "utf8");
}

function sliceFields(content: string): Record<string, unknown> {
  return matter(content).data;
}
