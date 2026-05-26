import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("phase auto-doc CLI", () => {
  test("prd publish appends slice doc to stderr without changing stdout", async () => {
    const fixture = await createFixture();
    await seedPhaseDoc(fixture.repoPath, "slice", "# Slice\nCreate the slice\n");

    const result = await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("updated PRD-0001");
    expect(result.stderr).toContain("--- phase doc: slice ---\n# Slice\nCreate the slice\n");
  });

  test("slice red appends green doc to stderr without changing stdout", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await wantFail(fixture);
    await seedPhaseDoc(fixture.repoPath, "green", "# Green\nMake it pass\n");

    const result = await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2"], fixture);

    const logPath = join(fixture.repoPath, ".wiki", "state", "slices", "SLICE-0001-red.log");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${logPath}\n`);
    expect(result.stderr).toContain(`red captured at ${logPath}`);
    expect(result.stderr).toContain("--- phase doc: green ---\n# Green\nMake it pass\n");
  });

  test("slice green appends close doc and slice close appends handover doc", async () => {
    const fixture = await createFixture();
    await createSliceWithAcceptance(fixture);
    await wantFail(fixture);
    expect((await runWiki(["slice", "red", "SLICE-0001", "--project", "wiki-v2", "--no-doc"], fixture)).exitCode).toBe(0);
    await wantPass(fixture);
    await seedPhaseDoc(fixture.repoPath, "close", "# Close\nReview and close\n");
    await seedPhaseDoc(fixture.repoPath, "handover", "# Handover\nTransfer context\n");

    const green = await runWiki(["slice", "green", "SLICE-0001", "--project", "wiki-v2"], fixture);
    await runWiki(["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "todo", "t1|Done|true"], fixture);
    const close = await runWiki(["slice", "close", "SLICE-0001", "--project", "wiki-v2", "--review-verdict", "pass"], fixture);

    expect(green.exitCode).toBe(0);
    expect(green.stdout).toBe(`${join(fixture.repoPath, ".wiki", "state", "slices", "SLICE-0001-green.log")}\n`);
    expect(green.stderr).toContain("--- phase doc: close ---\n# Close\nReview and close\n");
    expect(close.exitCode).toBe(0);
    expect(close.stdout).toBe("");
    expect(close.stderr).toContain("closed with verdict pass");
    expect(close.stderr).toContain("--- phase doc: handover ---\n# Handover\nTransfer context\n");
  });

  test("handover write uses next phase doc and handover create defaults to ad-hoc", async () => {
    const fixture = await createFixture();
    await seedPhaseDoc(fixture.repoPath, "slice", "# Slice\nNext slice\n");
    await seedPhaseDoc(fixture.repoPath, "ad-hoc", "# Ad hoc\nDecide next\n");

    const write = await runWiki(["handover", "write", "--project", "wiki-v2", "--phase", "handover", "--next-phase", "slice"], fixture);
    const create = await runWiki(["handover", "create", "--project", "wiki-v2", "--phase", "handover"], fixture);

    expect(write.exitCode).toBe(0);
    expect(write.stdout).toBe("HANDOVER-0001\n");
    expect(write.stderr).toContain("--- phase doc: slice ---\n# Slice\nNext slice\n");
    expect(create.exitCode).toBe(0);
    expect(create.stdout).toBe("HANDOVER-0002\n");
    expect(create.stderr).toContain("--- phase doc: ad-hoc ---\n# Ad hoc\nDecide next\n");
  });

  test("--no-doc suppresses auto doc and --doc-phase overrides selected phase", async () => {
    const fixture = await createFixture();
    await seedPhaseDoc(fixture.repoPath, "custom", "# Custom\nUse override\n");

    const suppressed = await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2", "--no-doc"], fixture);
    await runWiki(["prd", "set", "PRD-0001", "--project", "wiki-v2", "--field", "status", "draft"], fixture);
    const overridden = await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2", "--doc-phase", "custom"], fixture);

    expect(suppressed.exitCode).toBe(0);
    expect(suppressed.stderr).not.toContain("phase doc");
    expect(overridden.exitCode).toBe(0);
    expect(overridden.stderr).toContain("--- phase doc: custom ---\n# Custom\nUse override\n");
  });

  test("missing auto doc is non-fatal and reported on stderr", async () => {
    const fixture = await createFixture();

    const result = await runWiki(["prd", "publish", "PRD-0001", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("updated PRD-0001");
    expect(result.stderr).toContain("phase doc missing: slice");
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

async function createFixture(): Promise<Fixture> {
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
  await writeFile(qmdCommand, "#!/usr/bin/env bash\nset -euo pipefail\ncase \"${1:-}\" in\n  collection) exit 0 ;;\n  query) echo '[]' ;;\nesac\n");
  await chmod(qmdCommand, 0o755);

  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(
    join(projectPath, "_project.md"),
    `---\nproject: ${project}\nrepo: ${repoPath}\ntest_command: ${scriptPath} ${statePath}\nqmd_command: ${qmdCommand}\n---\n# ${project}\n`,
  );
  expect((await runWiki(["prd", "create", "--title", "Core wiki CLI", "--project", project], { vaultRoot, repoPath, statePath })).exitCode).toBe(0);
  return { vaultRoot, repoPath, statePath };
}

async function createSliceWithAcceptance(fixture: Fixture): Promise<void> {
  expect(
    (await runWiki(["slice", "create", "--title", "Build slice authoring", "--project", "wiki-v2", "--parent-prd", "PRD-0001"], fixture))
      .exitCode,
  ).toBe(0);
  expect(
    (await runWiki(["slice", "append", "SLICE-0001", "--project", "wiki-v2", "--field", "acceptance", "First criterion"], fixture))
      .exitCode,
  ).toBe(0);
}

async function seedPhaseDoc(repoPath: string, phase: string, content: string): Promise<void> {
  await mkdir(join(repoPath, "skills", "wiki"), { recursive: true });
  await writeFile(join(repoPath, "skills", "wiki", `PHASE-${phase.toUpperCase()}.md`), content);
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

async function runWiki(args: string[], fixture: Fixture): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: fixture.repoPath,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh") },
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
