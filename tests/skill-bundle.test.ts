import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPhaseDoc } from "../src/cli/phase-docs";

const repoRoot = import.meta.dir.replace(/\/tests$/, "");
const skillDir = join(repoRoot, "skills", "wiki");

const requiredFiles = [
  "SKILL.md",
  "PHASE-PLAN.md",
  "PHASE-PRD.md",
  "PHASE-SLICE.md",
  "PHASE-TRIAGE.md",
  "PHASE-HANDOVER.md",
  "ADMIN-VAULT.md",
  "ADMIN-MIGRATION.md",
] as const;

const triggerTerms = ["vault", "PRD", "slice", "decision", "TDD", "close", "handover", "init", "doctor", "migrate"] as const;
const phaseDocs = ["plan", "prd", "slice", "triage", "handover"] as const;

describe("wiki skill bundle", () => {
  test("required source files are the only non-placeholder files in skills/wiki", async () => {
    const entries = (await readdir(skillDir)).sort();

    expect(entries).toEqual([...requiredFiles].sort());
  });

  test("all required files are non-empty", async () => {
    for (const file of requiredFiles) {
      const content = await readFile(join(skillDir, file), "utf8");
      expect(content.trim().length).toBeGreaterThan(0);
    }
  });

  test("SKILL.md stays within the line cap and exposes trigger terms in its description", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const lineCount = skill.split("\n").length;
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";

    expect(lineCount).toBeLessThanOrEqual(100);
    for (const term of triggerTerms) {
      expect(description).toContain(term);
    }
  });

  test("phase docs carry lineage frontmatter and can be read by the phase doc loader", async () => {
    for (const phase of phaseDocs) {
      const doc = await loadPhaseDoc(repoRoot, phase);

      expect(doc).not.toBeNull();
      expect(doc).toMatch(/^---\n[\s\S]*(based-on:|source: wiki-v2)[\s\S]*---\n/);
    }
  });

  test("status --with-doc reads the repo-owned phase docs", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    const sessionPath = join(repoRoot, ".wiki", "state", "session.json");
    const existingSession = await readFile(sessionPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });

    try {
      await mkdir(join(vaultRoot, "projects", "wiki-v2"), { recursive: true });
      await writeFile(join(vaultRoot, "projects", "wiki-v2", "_project.md"), `---\nproject: wiki-v2\nrepo: ${repoRoot}\ntest_command: bun test\n---\n# wiki-v2\n`);
      await mkdir(join(repoRoot, ".wiki", "state"), { recursive: true });
      await writeFile(
        sessionPath,
        JSON.stringify({ project: "wiki-v2", phase: "slice", active_slices: [], updated: "2026-05-26T00:00:00.000Z" }, null, 2),
      );

      const result = await runWiki(["status", "--project", "wiki-v2", "--with-doc"], vaultRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--- phase doc: slice ---\n---\nbased-on:");
      expect(result.stdout).toContain("# Phase: slice");
    } finally {
      if (existingSession === null) {
        await rm(sessionPath, { force: true });
      } else {
        await writeFile(sessionPath, existingSession);
      }
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh") },
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
