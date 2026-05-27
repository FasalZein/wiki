import matter from "gray-matter";
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
  test("session start writes repo-local session.json", async () => {
    const fixture = await createFixture();

    const result = await runWiki(
      [
        "session",
        "start",
        "--project",
        "wiki-v2",
        "--active-prd",
        "PRD-001",
        "--active-slice",
        "SLICE-011",
        "--phase",
        "green",
      ],
      fixture,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${join(fixture.repoPath, ".wiki", "state", "session.json")}\n`);
    const session = JSON.parse(await readFile(join(fixture.repoPath, ".wiki", "state", "session.json"), "utf8"));
    expect(session.project).toBe("wiki-v2");
    expect(session.active_prd).toBe("PRD-001");
    expect(session.active_slices).toEqual(["SLICE-011"]);
    expect(session.phase).toBe("green");
    expect(session.updated).toBeString();
  });

  test("show and status without session exit 0 with helpful messages", async () => {
    const fixture = await createFixture();

    const show = await runWiki(["session", "show", "--project", "wiki-v2"], fixture);
    const status = await runWiki(["status", "--project", "wiki-v2"], fixture);

    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("No active session");
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("No active session for project wiki-v2");
  });

  test("status prints summary and simple next action", async () => {
    const fixture = await createFixture();
    await runWiki(
      ["session", "start", "--project", "wiki-v2", "--active-prd", "PRD-001", "--active-slice", "SLICE-011", "--phase", "green"],
      fixture,
    );

    const result = await runWiki(["status", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Project: wiki-v2");
    expect(result.stdout).toContain("Phase: green");
    expect(result.stdout).toContain("Active PRD: PRD-001");
    expect(result.stdout).toContain("Active slices: SLICE-011");
    expect(result.stdout).toContain("Next: run wiki slice close SLICE-011 --project wiki-v2 --review-verdict pass");
  });

  test("status and session show can read the current repo session without --project", async () => {
    const fixture = await createFixture();
    await runWiki(["session", "start", "--project", "wiki-v2", "--phase", "ad-hoc"], fixture);
    const repoFixture = { ...fixture, cwd: fixture.repoPath };

    const status = await runWiki(["status"], repoFixture);
    const show = await runWiki(["session", "show"], repoFixture);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Project: wiki-v2");
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout).project).toBe("wiki-v2");
  });

  test("status --with-doc appends seeded phase doc", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.repoPath, "skills", "wiki"), { recursive: true });
    await writeFile(join(fixture.repoPath, "skills", "wiki", "PHASE-GREEN.md"), "# Green\nShip it\n");
    await runWiki(["session", "start", "--project", "wiki-v2", "--phase", "green"], fixture);

    const result = await runWiki(["status", "--project", "wiki-v2", "--with-doc"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--- phase doc: green ---\n# Green\nShip it\n");
    expect(result.stderr).toBe("");
  });

  test("status --with-doc missing doc is non-fatal", async () => {
    const fixture = await createFixture();
    await runWiki(["session", "start", "--project", "wiki-v2", "--phase", "green"], fixture);

    const result = await runWiki(["status", "--project", "wiki-v2", "--with-doc"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Project: wiki-v2");
    expect(result.stderr).toContain("phase doc not found");
  });

  test("session set updates fields and supports stdin notes", async () => {
    const fixture = await createFixture();
    await runWiki(["session", "start", "--project", "wiki-v2", "--phase", "red"], fixture);

    const phase = await runWiki(["session", "set", "--project", "wiki-v2", "--field", "phase", "green"], fixture);
    const notes = await runWiki(["session", "set", "--project", "wiki-v2", "--field", "notes", "-"], fixture, "Working notes\n");

    expect(phase.exitCode).toBe(0);
    expect(notes.exitCode).toBe(0);
    const session = JSON.parse(await readFile(join(fixture.repoPath, ".wiki", "state", "session.json"), "utf8"));
    expect(session.phase).toBe("green");
    expect(session.notes).toBe("Working notes\n");
  });

  test("session clear removes session.json", async () => {
    const fixture = await createFixture();
    await runWiki(["session", "start", "--project", "wiki-v2"], fixture);

    const result = await runWiki(["session", "clear", "--project", "wiki-v2"], fixture);
    const status = await runWiki(["status", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(status.stdout).toContain("No active session");
  });

  test("handover create/write fill omitted fields from session and explicit flags override", async () => {
    const fixture = await createFixture();
    await runWiki(
      ["session", "start", "--project", "wiki-v2", "--active-prd", "PRD-001", "--active-slice", "SLICE-011", "--phase", "green"],
      fixture,
    );

    const fromSession = await runWiki(["handover", "create", "--project", "wiki-v2"], fixture);
    const override = await runWiki(
      ["handover", "write", "--project", "wiki-v2", "--phase", "handover", "--active-prd", "PRD-999", "--active-slice", "SLICE-999"],
      fixture,
    );

    expect(fromSession.exitCode).toBe(0);
    expect(override.exitCode).toBe(0);
    const first = matter(await readFile(join(fixture.vaultRoot, "projects", "wiki-v2", "handovers", "HANDOVER-0001.md"), "utf8")).data;
    const second = matter(await readFile(join(fixture.vaultRoot, "projects", "wiki-v2", "handovers", "HANDOVER-0002.md"), "utf8")).data;
    expect(first.phase).toBe("green");
    expect(first.active_prd).toBe("PRD-001");
    expect(first.active_slices).toEqual(["SLICE-011"]);
    expect(second.phase).toBe("handover");
    expect(second.active_prd).toBe("PRD-999");
    expect(second.active_slices).toEqual(["SLICE-999"]);
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
  await writeFile(join(projectPath, "_project.md"), `---\nproject: ${project}\nrepo: ${repoPath}\ntest_command: bun test\n---\n# ${project}\n`);
  return { vaultRoot, repoPath, cwd };
}

async function runWiki(args: string[], fixture: Fixture, stdin?: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: fixture.cwd,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh") },
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
