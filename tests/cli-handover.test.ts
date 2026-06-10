import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("handover CLI", () => {
  test("handover create with required flags writes an open handover", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HANDOVER-0001\n");
    expect(result.stderr).toContain("created HANDOVER-0001");
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("id: HANDOVER-0001");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("phase: plan");
    expect(file).toContain("status: open");
  });

  test("handover create missing --phase exits 1", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "--project", "wiki-v2"], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("phase");
    expect(result.stdout).toBe("");
  });

  test("handover create without --project uses session project", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(["handover", "--phase", "plan"], vaultRoot);

    expect(result.exitCode).toBe(0);
  });

  test("handover create stores repeated active slices", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      [
        "handover",
        "--project",
        "wiki-v2",
        "--phase",
        "plan",
        "--active-slice",
        "SLICE-0001",
        "--active-slice",
        "SLICE-0002",
      ],
      vaultRoot,
    );

    expect(result.exitCode).toBe(0);
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("active_slices:\n  - SLICE-0001\n  - SLICE-0002");
  });

  test("handover create reads produced prose from stdin", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    const result = await runWiki(
      ["handover", "--project", "wiki-v2", "--phase", "plan", "--produced", "-"],
      vaultRoot,
      "Built one thing\nVerified it",
    );

    expect(result.exitCode).toBe(0);
    const file = await readHandover(vaultRoot, "HANDOVER-0001");
    expect(file).toContain("Built one thing\nVerified it");
  });

  // --- SLICE-0055: handover finishes the loop by advancing the session phase ---

  test("handover with --next-phase advances the session phase (SLICE-0055)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    await withSession("wiki-v2", "slice", async () => {
      const result = await runWiki(["handover", "--phase", "handover", "--next-phase", "prd"], vaultRoot);

      expect(result.exitCode).toBe(0);
      const session = JSON.parse(await readFile(sessionPath, "utf8")) as { phase: string };
      expect(session.phase).toBe("prd");
    });
  });

  test("handover without --next-phase leaves the session untouched (SLICE-0055)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    await withSession("wiki-v2", "slice", async () => {
      const before = await readFile(sessionPath, "utf8");

      const result = await runWiki(["handover", "--phase", "handover"], vaultRoot);

      expect(result.exitCode).toBe(0);
      expect(await readFile(sessionPath, "utf8")).toBe(before);
    });
  });

  // --- SLICE-0056: copy-paste next-session resume prompt ---

  test("handover emits a delimited next-session prompt on stderr (SLICE-0056)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    await withSession("wiki-v2", "handover", async () => {
      const result = await runWiki(
        [
          "handover", "--phase", "handover", "--next-phase", "slice",
          "--active-slice", "SLICE-0042",
          "--suggested-skill", "to-slices",
          "--open", "Finish the resolver seam, then re-run doctor.",
        ],
        vaultRoot,
      );

      expect(result.exitCode).toBe(0);
      // stdout stays machine-clean: bare ID only.
      expect(result.stdout).toBe("HANDOVER-0001\n");
      const err = result.stderr;
      expect(err).toContain("next session prompt");
      expect(err).toContain("Read HANDOVER-0001");
      expect(err).toContain("wiki status --project wiki-v2 --with-doc");
      expect(err).toContain("slice");
      expect(err).toContain("SLICE-0042");
      expect(err).toContain("to-slices");
      expect(err).toContain("Finish the resolver seam, then re-run doctor.");
    });
  });

  test("prompt omits empty sections and prints without a session (SLICE-0056)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    await withSession(null, null, async () => {
      const result = await runWiki(["handover", "--project", "wiki-v2", "--phase", "plan"], vaultRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("next session prompt");
      expect(result.stderr).toContain("Read HANDOVER-0001");
      expect(result.stderr).not.toContain("Open work:");
      expect(result.stderr).not.toContain("Suggested skill");
    });
  });

  test("handover with explicit --project and no session creates no session file (SLICE-0055)", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");

    await withSession(null, null, async () => {
      const result = await runWiki(
        ["handover", "--project", "wiki-v2", "--phase", "plan", "--next-phase", "slice"],
        vaultRoot,
      );

      expect(result.exitCode).toBe(0);
      expect(await readFile(sessionPath, "utf8").catch(() => null)).toBeNull();
    });
  });
});

const repoRoot = import.meta.dir.replace(/\/tests$/, "");
const sessionPath = join(repoRoot, ".wiki", "state", "session.json");

/** Run `fn` with the repo session forced to project/phase (or absent when null), then restore. */
async function withSession(project: string | null, phase: string | null, fn: () => Promise<void>): Promise<void> {
  const existing = await readFile(sessionPath, "utf8").catch(() => null);
  try {
    if (project === null) {
      await rm(sessionPath, { force: true });
    } else {
      await mkdir(join(repoRoot, ".wiki", "state"), { recursive: true });
      await writeFile(
        sessionPath,
        JSON.stringify({ project, phase: phase ?? "ad-hoc", active_slices: [], updated: "2026-06-10T00:00:00.000Z" }, null, 2),
      );
    }
    await fn();
  } finally {
    if (existing === null) {
      await rm(sessionPath, { force: true });
    } else {
      await writeFile(sessionPath, existing);
    }
  }
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string, stdin?: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh") },
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

async function createFixtureVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
  await mkdir(join(projectPath, "docs"));
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}

async function readHandover(vaultRoot: string, id: string): Promise<string> {
  return readFile(join(vaultRoot, "projects", "wiki-v2", "handovers", `${id}-${id.toLowerCase()}.md`), "utf8");
}
