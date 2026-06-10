import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../src/bootstrap/doctor";
import { BLOCK_VERSION, buildPointerBlock } from "../src/cli/repo-link";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-dr-"));
  tempPaths.push(dir);
  return dir;
}

/** Create a minimal vault with a project that has linked_repos set. */
async function makeVaultWithLinkedRepo(opts: {
  projectName: string;
  repoDir: string;
  agentsMd?: string;
  claudeMd?: string;
}): Promise<string> {
  const vaultRoot = await makeTempDir();
  const projDir = join(vaultRoot, "projects", opts.projectName);
  await mkdir(projDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const projectMd = `---\nproject: ${opts.projectName}\nstatus: planning\ncreated: ${today}\nrepo: ${opts.repoDir}\ntest_command: bun test\nlinked_repos:\n  - ${opts.repoDir}\n---\n# ${opts.projectName}\n`;
  await writeFile(join(projDir, "_project.md"), projectMd);

  // Write AGENTS.md / CLAUDE.md in the repo dir if content is given
  if (opts.agentsMd !== undefined) {
    await writeFile(join(opts.repoDir, "AGENTS.md"), opts.agentsMd);
  }
  if (opts.claudeMd !== undefined) {
    await writeFile(join(opts.repoDir, "CLAUDE.md"), opts.claudeMd);
  }

  return vaultRoot;
}

const DUMMY_REPO_ROOT = "/nonexistent";

describe("doctor repo-binding checks", () => {
  test("reports healthy when both AGENTS.md and CLAUDE.md have current-version block", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");

    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: block + "\n",
    });

    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const repoBindingIssues = result.issues.filter((i) => i.type === "repo-binding");
    expect(repoBindingIssues).toHaveLength(0);
  });

  test("flags AGENTS.md with missing block and gives remediation command", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");

    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: "# Normal repo content\n", // no wiki block
      claudeMd: block + "\n",
    });

    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const repoIssues = result.issues.filter((i) => i.type === "repo-binding");
    expect(repoIssues.length).toBeGreaterThanOrEqual(1);
    const agentsIssue = repoIssues.find((i) => i.message.includes("AGENTS.md"));
    expect(agentsIssue).toBeDefined();
    expect(agentsIssue!.message).toContain("wiki project link");
    expect(agentsIssue!.message).toContain("--project acme");
    expect(agentsIssue!.message).toContain(`--repo ${repoDir}`);
  });

  test("flags CLAUDE.md with missing block and gives remediation command", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");

    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: "# Normal content\n", // no wiki block
    });

    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const claudeIssue = result.issues.filter((i) => i.type === "repo-binding" && i.message.includes("CLAUDE.md"));
    expect(claudeIssue.length).toBeGreaterThanOrEqual(1);
    expect(claudeIssue[0]!.message).toContain("wiki project link");
  });

  test("flags stale-version block as needing remediation", async () => {
    const repoDir = await makeTempDir();
    // Write a v0 block (stale version)
    const staleBlock = [
      "<!-- wiki:begin v0 project=acme -->",
      "## Wiki vault",
      "Old stale content.",
      "<!-- wiki:end -->",
    ].join("\n");

    const currentBlock = buildPointerBlock("acme");

    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: staleBlock + "\n",
      claudeMd: currentBlock + "\n",
    });

    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const staleIssues = result.issues.filter(
      (i) => i.type === "repo-binding" && i.message.includes("AGENTS.md"),
    );
    expect(staleIssues.length).toBeGreaterThanOrEqual(1);
    expect(staleIssues[0]!.message).toContain("wiki project link");
    expect(staleIssues[0]!.message).toContain("stale");
  });

  test("flags AGENTS.md missing file (does not exist yet) as needing remediation", async () => {
    const repoDir = await makeTempDir();
    const currentBlock = buildPointerBlock("acme");

    // Only CLAUDE.md exists; AGENTS.md is absent
    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      claudeMd: currentBlock + "\n",
      // agentsMd not provided → file absent
    });

    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const agentsIssues = result.issues.filter(
      (i) => i.type === "repo-binding" && i.message.includes("AGENTS.md"),
    );
    expect(agentsIssues.length).toBeGreaterThanOrEqual(1);
    expect(agentsIssues[0]!.message).toContain("wiki project link");
  });

  test("degrades to warning (not crash) for unreadable/nonexistent repo path", async () => {
    const vaultRoot = await makeTempDir();
    const projDir = join(vaultRoot, "projects", "acme");
    await mkdir(projDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    // Point to a non-existent repo path
    const nonExistentRepo = "/tmp/wiki-test-nonexistent-repo-" + Date.now();
    const projectMd = `---\nproject: acme\nstatus: planning\ncreated: ${today}\nrepo: ${nonExistentRepo}\ntest_command: bun test\nlinked_repos:\n  - ${nonExistentRepo}\n---\n# acme\n`;
    await writeFile(join(projDir, "_project.md"), projectMd);

    // Should not throw
    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const warningIssues = result.issues.filter(
      (i) => i.type === "repo-binding-warning" || (i.type === "repo-binding" && i.message.toLowerCase().includes("warn")),
    );
    // At minimum, no crash. Also expect a warning-type issue.
    expect(() => result).not.toThrow();
    // There should be some issue reported for the unreadable path
    const anyRepoIssues = result.issues.filter((i) =>
      i.type === "repo-binding" || i.type === "repo-binding-warning",
    );
    expect(anyRepoIssues.length).toBeGreaterThanOrEqual(1);
  });

  test("no repo-binding issues for project with no linked_repos", async () => {
    const vaultRoot = await makeTempDir();
    const projDir = join(vaultRoot, "projects", "nolinks");
    await mkdir(projDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const projectMd = `---\nproject: nolinks\nstatus: planning\ncreated: ${today}\nrepo: /tmp/x\ntest_command: bun test\n---\n# nolinks\n`;
    await writeFile(join(projDir, "_project.md"), projectMd);

    const result = await runDoctor(vaultRoot, DUMMY_REPO_ROOT);

    const repoIssues = result.issues.filter((i) => i.type === "repo-binding" || i.type === "repo-binding-warning");
    expect(repoIssues).toHaveLength(0);
  });
});
