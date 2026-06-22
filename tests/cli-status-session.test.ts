import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("status and repo-project binding CLI", () => {
  test("status on a project with no artifacts names the project and how to create", async () => {
    const fixture = await createFixture();

    const result = await runWiki(["status", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Project: wiki-v2");
    expect(result.stdout).toContain("No artifacts yet");
  });

  test("status lists the most-recently-modified artifacts", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.vaultRoot, "projects", "wiki-v2", "docs", "DOC-0001-thing.md"),
      "---\nid: DOC-0001\n---\n# Thing\n",
    );

    const result = await runWiki(["status", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Project: wiki-v2");
    expect(result.stdout).toContain("Recent artifacts (1):");
    expect(result.stdout).toContain(join("projects", "wiki-v2", "docs", "DOC-0001-thing.md"));
  });

  test("status --json emits project and recent artifact paths", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.vaultRoot, "projects", "wiki-v2", "docs", "DOC-0001-thing.md"),
      "---\nid: DOC-0001\n---\n# Thing\n",
    );

    const result = await runWiki(["status", "--project", "wiki-v2", "--json"], fixture);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.project).toBe("wiki-v2");
    expect(payload.recent).toEqual([join("projects", "wiki-v2", "docs", "DOC-0001-thing.md")]);
  });

  test("status reads the repo's linked project from the pointer block without --project", async () => {
    const fixture = await createFixture();
    const repoFixture = { ...fixture, cwd: fixture.repoPath };
    await runWiki(["project", "link", "--project", "wiki-v2"], repoFixture);

    const status = await runWiki(["status"], repoFixture);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Project: wiki-v2");
  });
});

type Fixture = {
  vaultRoot: string;
  repoPath: string;
  cwd: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function createFixture(): Promise<Fixture> {
  const project = "wiki-v2";
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  const repoPath = await mkdtemp(join(tmpdir(), "wiki-repo-"));
  const cwd = await mkdtemp(join(tmpdir(), "wiki-cli-cwd-"));
  tempPaths.push(vaultRoot, repoPath, cwd);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  await writeFile(join(projectPath, "_project.md"), `---\nproject: ${project}\nrepo: ${repoPath}\ntest_command: bun test\n---\n# ${project}\n`);
  return { vaultRoot, repoPath, cwd };
}

async function runWiki(args: string[], fixture: Fixture, stdin?: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: fixture.cwd,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot },
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
