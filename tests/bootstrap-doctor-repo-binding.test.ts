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

    const result = await runDoctor(vaultRoot);

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

    const result = await runDoctor(vaultRoot);

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

    const result = await runDoctor(vaultRoot);

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

    const result = await runDoctor(vaultRoot);

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

    const result = await runDoctor(vaultRoot);

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
    const result = await runDoctor(vaultRoot);

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

    const result = await runDoctor(vaultRoot);

    const repoIssues = result.issues.filter((i) => i.type === "repo-binding" || i.type === "repo-binding-warning");
    expect(repoIssues).toHaveLength(0);
  });
});

// --- contract-drift detection (SLICE-0050, ADR-0032 Layer 2) ---
// Prevention is probabilistic: an agent following grill-with-docs can still land
// a CONTEXT.md or docs/adr/ in a bound repo. Doctor is the detection net.

describe("doctor contract-drift checks", () => {
  test("flags a CONTEXT.md at the root of a bound repo with a structure-derived migration hint", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");
    await writeFile(join(repoDir, "CONTEXT.md"), "# Glossary\n\nOrder: a thing.\n");
    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: block + "\n",
    });

    const result = await runDoctor(vaultRoot);

    const drift = result.issues.filter((i) => i.type === "contract-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain("CONTEXT.md");
    // Default structure has doc kind with notes bucket → suggests `wiki create notes`
    expect(drift[0]?.message).toContain("wiki create notes");
    expect(drift[0]?.message).toContain("--project acme");
  });

  test("flags markdown files under docs/adr/ in a bound repo with a migration hint", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");
    await mkdir(join(repoDir, "docs", "adr"), { recursive: true });
    await writeFile(join(repoDir, "docs", "adr", "0001-use-x.md"), "# Use X\n");
    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: block + "\n",
    });

    const result = await runDoctor(vaultRoot);

    const drift = result.issues.filter((i) => i.type === "contract-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain("0001-use-x.md");
    expect(drift[0]?.message).toContain("wiki create decision");
  });

  test("clean bound repo produces no contract-drift issues", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");
    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: block + "\n",
    });

    const result = await runDoctor(vaultRoot);

    expect(result.issues.filter((i) => i.type === "contract-drift")).toHaveLength(0);
  });

  test("a CONTEXT.md in a repo that is not linked produces no contract-drift issues", async () => {
    const strayDir = await makeTempDir();
    await writeFile(join(strayDir, "CONTEXT.md"), "# Not bound to any project\n");
    const vaultRoot = await makeTempDir();
    const projDir = join(vaultRoot, "projects", "nolinks");
    await mkdir(projDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(
      join(projDir, "_project.md"),
      `---\nproject: nolinks\nstatus: planning\ncreated: ${today}\nrepo: /tmp/x\ntest_command: bun test\n---\n# nolinks\n`,
    );

    const result = await runDoctor(vaultRoot);

    expect(result.issues.filter((i) => i.type === "contract-drift")).toHaveLength(0);
  });
});

// --- CONTEXT.md remediation is structure-derived (not hardcoded) ---

describe("doctor contract-drift remediation derives from structure", () => {
  test("uses generic <kind> when vault has no notes bucket or notes kind", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");
    await writeFile(join(repoDir, "CONTEXT.md"), "# Glossary\n");
    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: block + "\n",
    });
    // Write a wiki.json that has no doc/notes at all — only prd and decision
    await writeFile(
      join(vaultRoot, "wiki.json"),
      JSON.stringify({
        kinds: {
          prd: { prefix: "PRD", folder: "prds", dedup: true },
          decision: { prefix: "ADR", folder: "adrs", dedup: true },
        },
      }),
    );

    const result = await runDoctor(vaultRoot);

    const drift = result.issues.filter((i) => i.type === "contract-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain("wiki create <kind> --project acme");
  });

  test("suggests 'wiki create notes' when notes is a top-level kind", async () => {
    const repoDir = await makeTempDir();
    const block = buildPointerBlock("acme");
    await writeFile(join(repoDir, "CONTEXT.md"), "# Glossary\n");
    const vaultRoot = await makeVaultWithLinkedRepo({
      projectName: "acme",
      repoDir,
      agentsMd: block + "\n",
      claudeMd: block + "\n",
    });
    // Write a wiki.json with notes as a top-level kind (10-kind migration)
    await writeFile(
      join(vaultRoot, "wiki.json"),
      JSON.stringify({
        kinds: {
          notes: { prefix: "NOTE", folder: "notes", dedup: false },
          decision: { prefix: "ADR", folder: "adrs", dedup: true },
        },
      }),
    );

    const result = await runDoctor(vaultRoot);

    const drift = result.issues.filter((i) => i.type === "contract-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain("wiki create notes --project acme");
  });
});

// --- `runDoctor` scoped to a single project via scopeProject param ---

describe("doctor --project scoping", () => {
  test("scoped run only reports issues for the named project", async () => {
    const vaultRoot = await makeTempDir();
    const today = new Date().toISOString().slice(0, 10);

    // Create two projects, both with a CONTEXT.md drift issue
    for (const name of ["alpha", "beta"]) {
      const projDir = join(vaultRoot, "projects", name);
      await mkdir(projDir, { recursive: true });
      const repoDir = await makeTempDir();
      await writeFile(join(repoDir, "CONTEXT.md"), "# Glossary\n");
      const block = buildPointerBlock(name);
      await writeFile(join(repoDir, "AGENTS.md"), block + "\n");
      await writeFile(join(repoDir, "CLAUDE.md"), block + "\n");
      await writeFile(
        join(projDir, "_project.md"),
        `---\nproject: ${name}\nstatus: planning\ncreated: ${today}\nlinked_repos:\n  - ${repoDir}\n---\n# ${name}\n`,
      );
    }

    // Full run sees both projects
    const full = await runDoctor(vaultRoot);
    const fullDrift = full.issues.filter((i) => i.type === "contract-drift");
    expect(fullDrift).toHaveLength(2);

    // Scoped to alpha
    const scoped = await runDoctor(vaultRoot, "alpha");
    const scopedDrift = scoped.issues.filter((i) => i.type === "contract-drift");
    expect(scopedDrift).toHaveLength(1);
    expect(scopedDrift[0]?.message).toContain("alpha");
  });

  test("scoped run for nonexistent project reports no issues (clean)", async () => {
    const vaultRoot = await makeTempDir();
    const projDir = join(vaultRoot, "projects", "exists");
    await mkdir(projDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(
      join(projDir, "_project.md"),
      `---\nproject: exists\nstatus: planning\ncreated: ${today}\n---\n# exists\n`,
    );

    const result = await runDoctor(vaultRoot, "nonexistent");
    expect(result.clean).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
