import matter from "gray-matter";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

  test("red on planned with empty acceptance exits 1", async () => {
    const fixture = await createFixture();
    await createSlice(fixture);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("acceptance");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });

  test("red captures a failing run and atomically sets status plus red log", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await wantFail(fixture);

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    const logPath = join(fixture.repoPath, ".wiki", "state", "slices", "SLICE-0001-red.log");
    expect(result.stdout).toBe(`${logPath}\n`);
    expect(result.stderr).toContain(`red captured at ${logPath}`);
    expect(await readFile(logPath, "utf8")).toContain("(fake) test failed");
    const fields = sliceFields(await readSlice(fixture.vaultRoot));
    expect(fields.status).toBe("red");
    expect(fields.red_log_ref).toBe(logPath);
  });

  test("red refuses a passing run and leaves the slice unchanged", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no failing tests captured");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });

  test("green on non-red exits 2", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(["slice", "green", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot green SLICE-0001 from status planned");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });

  test("green captures a passing run and atomically sets status plus green log", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await wantFail(fixture);
    expect((await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot)).exitCode).toBe(0);
    await wantPass(fixture);

    const result = await runWiki(["slice", "green", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(0);
    const logPath = join(fixture.repoPath, ".wiki", "state", "slices", "SLICE-0001-green.log");
    expect(result.stdout).toBe(`${logPath}\n`);
    expect(result.stderr).toContain(`green captured at ${logPath}`);
    expect(await readFile(logPath, "utf8")).toContain("(fake) test passed");
    const fields = sliceFields(await readSlice(fixture.vaultRoot));
    expect(fields.status).toBe("green");
    expect(fields.green_log_ref).toBe(logPath);
  });

  test("green refuses a failing run and leaves the slice unchanged", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await wantFail(fixture);
    expect((await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot)).exitCode).toBe(0);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(["slice", "green", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("tests still failing");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });

  test("close on non-green non-exempt exits 2", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(
      ["slice", "close", "SLICE-0001", "--project", "wiki-v2", "--review-verdict", "pass"],
      fixture.vaultRoot,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot close SLICE-0001 from status planned");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });

  test("close with unfinished todo exits 1 and names the todo", async () => {
    const fixture = await createGreenSlice();
    await runWiki(
      ["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "todo", "t1|Write implementation|false"],
      fixture.vaultRoot,
    );
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(
      ["slice", "close", "SLICE-0001", "--project", "wiki-v2", "--review-verdict", "pass"],
      fixture.vaultRoot,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unfinished todo t1: Write implementation");
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
  });

  test("close success sets review verdict and closed status", async () => {
    const fixture = await createGreenSlice();
    await runWiki(
      ["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "todo", "t1|Write implementation|true"],
      fixture.vaultRoot,
    );

    const result = await runWiki(
      ["slice", "close", "SLICE-0001", "--project", "wiki-v2", "--review-verdict", "pass-with-notes"],
      fixture.vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("closed with verdict pass-with-notes");
    const fields = sliceFields(await readSlice(fixture.vaultRoot));
    expect(fields.status).toBe("closed");
    expect(fields.review_verdict).toBe("pass-with-notes");
  });

  test("tdd_exempt planned slice closes directly when it has a valid reason", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await runWiki(["slice", "set", "SLICE-0001", "--project", "wiki-v2", "--field", "tdd_exempt", "true"], fixture.vaultRoot);
    await runWiki(
      [
        "slice",
        "set",
        "SLICE-0001",
        "--project",
        "wiki-v2",
        "--field",
        "tdd_exempt_reason",
        "Documentation-only change has no runnable behavior",
      ],
      fixture.vaultRoot,
    );

    const result = await runWiki(
      ["slice", "close", "SLICE-0001", "--project", "wiki-v2", "--review-verdict", "pass"],
      fixture.vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(sliceFields(await readSlice(fixture.vaultRoot)).status).toBe("closed");
  });

  test("tdd_exempt without a valid reason makes all state verbs exit 2", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await runWiki(["slice", "set", "SLICE-0001", "--project", "wiki-v2", "--field", "tdd_exempt", "true"], fixture.vaultRoot);

    const red = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);
    const green = await runWiki(["slice", "green", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);
    const close = await runWiki(
      ["slice", "close", "SLICE-0001", "--project", "wiki-v2", "--review-verdict", "pass"],
      fixture.vaultRoot,
    );

    expect(red.exitCode).toBe(2);
    expect(green.exitCode).toBe(2);
    expect(close.exitCode).toBe(2);
    expect(red.stderr).toContain("tdd_exempt requires");
    expect(green.stderr).toContain("tdd_exempt requires");
    expect(close.stderr).toContain("tdd_exempt requires");
  });

  test("red exits 10 when project config is missing repo or test_command", async () => {
    const fixture = await createFixture({ projectConfig: "---\nproject: wiki-v2\nrepo: /tmp/example\n---\n# wiki-v2\n" });
    await createSliceWithAcceptance(fixture);

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(10);
    expect(result.stderr).toContain("_project.md: missing 'repo' or 'test_command'");
  });

  test("failed captured runs do not update slice fields", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    const before = await readSlice(fixture.vaultRoot);

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(await readSlice(fixture.vaultRoot)).toBe(before);
    const fields = sliceFields(await readSlice(fixture.vaultRoot));
    expect(fields.red_log_ref).toBeUndefined();
    expect(fields.status).toBe("planned");
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

async function createFixture(options: { projectConfig?: string } = {}): Promise<Fixture> {
  const project = "wiki-v2";
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
  const qmdCommand = join(repoPath, "fake-qmd.sh");
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  collection) exit 0 ;;
  query) echo '[]' ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);

  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "decisions"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(
    join(projectPath, "_project.md"),
    options.projectConfig === undefined
      ? `---\nproject: ${project}\nrepo: ${repoPath}\ntest_command: ${scriptPath} ${statePath}\nqmd_command: ${qmdCommand}\n---\n# ${project}\n`
      : options.projectConfig.replace("---\n", `---\nqmd_command: ${qmdCommand}\n`),
  );
  const prd = await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", project], vaultRoot);
  expect(prd.exitCode).toBe(0);
  return { vaultRoot, repoPath, statePath };
}

async function createSlice(fixture: Fixture): Promise<void> {
  const create = await runWiki(
    ["slice", "create", "--title", "Build slice authoring", "--project", "wiki-v2", "--parent-prd", "PRD-0001"],
    fixture.vaultRoot,
  );
  expect(create.exitCode).toBe(0);
}

async function createSliceWithAcceptance(fixture: Fixture): Promise<void> {
  await createSlice(fixture);
  const append = await runWiki(
    ["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "acceptance", "First criterion"],
    fixture.vaultRoot,
  );
  expect(append.exitCode).toBe(0);
}

async function createGreenSlice(): Promise<Fixture> {
  const fixture = await createFixture();
  await createSliceWithAcceptance(fixture);
  await wantFail(fixture);
  expect((await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot)).exitCode).toBe(0);
  await wantPass(fixture);
  expect((await runWiki(["slice", "green", "SLICE-0001", "--project", "wiki-v2"], fixture.vaultRoot)).exitCode).toBe(0);
  return fixture;
}

async function wantFail(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.statePath, "want-fail"), "1");
}

async function wantPass(fixture: Fixture): Promise<void> {
  await unlink(join(fixture.statePath, "want-fail")).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  });
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
