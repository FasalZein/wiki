import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("status and session CLI", () => {
  test("session start writes repo-local session.json with {project, updated}", async () => {
    const fixture = await createFixture();

    const result = await runWiki(["session", "start", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${join(fixture.repoPath, ".wiki", "state", "session.json")}\n`);
    const session = JSON.parse(await readFile(join(fixture.repoPath, ".wiki", "state", "session.json"), "utf8"));
    expect(session.project).toBe("wiki-v2");
    expect(session.updated).toBeString();
  });

  test("session show without a session exits 0 with a helpful message", async () => {
    const fixture = await createFixture();

    const show = await runWiki(["session", "show", "--project", "wiki-v2"], fixture);

    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("No active session");
  });

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

  test("status and session show read the current repo session without --project", async () => {
    const fixture = await createFixture();
    await runWiki(["session", "start", "--project", "wiki-v2"], fixture);
    const repoFixture = { ...fixture, cwd: fixture.repoPath };

    const status = await runWiki(["status"], repoFixture);
    const show = await runWiki(["session", "show"], repoFixture);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Project: wiki-v2");
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout).project).toBe("wiki-v2");
  });

  test("session clear removes session.json", async () => {
    const fixture = await createFixture();
    await runWiki(["session", "start", "--project", "wiki-v2"], fixture);

    const result = await runWiki(["session", "clear", "--project", "wiki-v2"], fixture);
    const show = await runWiki(["session", "show", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(show.stdout).toContain("No active session");
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
  await mkdir(join(projectPath, "handovers"));
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
