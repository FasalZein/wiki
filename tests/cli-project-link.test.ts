import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { stampPointerBlock, BLOCK_VERSION, buildPointerBlock } from "../src/cli/repo-link";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-link-"));
  tempPaths.push(dir);
  return dir;
}

// --- unit tests for stampPointerBlock ---

describe("stampPointerBlock", () => {
  test("creates file with block at top when file does not exist", async () => {
    const repoDir = await makeTempDir();
    const filePath = join(repoDir, "AGENTS.md");

    await stampPointerBlock(filePath, "my-project");

    const content = await readFile(filePath, "utf8");
    expect(content).toContain(`<!-- wiki:begin v${BLOCK_VERSION} project=my-project -->`);
    expect(content).toContain("<!-- wiki:end -->");
    expect(content).toContain("## Wiki vault");
    expect(content).toContain("my-project");
    expect(content).toContain("wiki search");
    // block is at the very top
    expect(content.startsWith(`<!-- wiki:begin`)).toBe(true);
  });

  test("prepends block to existing file content", async () => {
    const repoDir = await makeTempDir();
    const filePath = join(repoDir, "CLAUDE.md");
    await writeFile(filePath, "# My existing docs\n\nSome content here.\n");

    await stampPointerBlock(filePath, "my-project");

    const content = await readFile(filePath, "utf8");
    // block at top
    expect(content.startsWith(`<!-- wiki:begin`)).toBe(true);
    // original content preserved
    expect(content).toContain("# My existing docs");
    expect(content).toContain("Some content here.");
  });

  test("replaces existing block idempotently on re-run", async () => {
    const repoDir = await makeTempDir();
    const filePath = join(repoDir, "AGENTS.md");

    await stampPointerBlock(filePath, "my-project");
    const firstContent = await readFile(filePath, "utf8");

    await stampPointerBlock(filePath, "my-project");
    const secondContent = await readFile(filePath, "utf8");

    expect(firstContent).toBe(secondContent);
    // only one begin/end pair
    const beginCount = (secondContent.match(/<!-- wiki:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  test("replaces stale-version block (different version in sentinel)", async () => {
    const repoDir = await makeTempDir();
    const filePath = join(repoDir, "AGENTS.md");

    // Write a v0 block manually
    const oldBlock = [
      "<!-- wiki:begin v0 project=my-project -->",
      "Old content that is stale.",
      "<!-- wiki:end -->",
      "",
      "# Real repo content",
    ].join("\n");
    await writeFile(filePath, oldBlock);

    await stampPointerBlock(filePath, "my-project");

    const content = await readFile(filePath, "utf8");
    expect(content).not.toContain("v0");
    expect(content).toContain(`v${BLOCK_VERSION}`);
    expect(content).not.toContain("Old content that is stale.");
    expect(content).toContain("# Real repo content");
    const beginCount = (content.match(/<!-- wiki:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  test("block body names the project and states vault-only policy", async () => {
    const repoDir = await makeTempDir();
    const filePath = join(repoDir, "AGENTS.md");
    await stampPointerBlock(filePath, "acme");

    const content = await readFile(filePath, "utf8");
    // project name appears in body
    expect(content).toContain("acme");
    // vault-only policy
    expect(content.toLowerCase()).toContain("wiki vault");
    expect(content.toLowerCase()).toMatch(/never in (this )?repo|not in.*(this )?repo|live in the wiki vault/);
    // skill entry instruction
    expect(content.toLowerCase()).toContain("wiki");
    // recall command
    expect(content).toContain(`wiki search`);
    expect(content).toContain(`--project acme`);
  });
});

// --- unit tests for buildPointerBlock ---

describe("buildPointerBlock", () => {
  test("produces valid sentinel-wrapped markdown", () => {
    const block = buildPointerBlock("test-proj");
    expect(block).toContain(`<!-- wiki:begin v${BLOCK_VERSION} project=test-proj -->`);
    expect(block).toContain("<!-- wiki:end -->");
  });
});

// --- integration tests via CLI ---

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: {
      ...process.env,
      KNOWLEDGE_VAULT_ROOT: vaultRoot,
      OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh"),
    },
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

async function createProjectVault(projectName: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  await mkdir(join(vaultRoot, "projects", projectName), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(
    join(vaultRoot, "projects", projectName, "_project.md"),
    `---\nproject: ${projectName}\nstatus: planning\ncreated: ${today}\nrepo: /tmp/some-repo\ntest_command: bun test\n---\n# ${projectName}\n`,
  );
  return vaultRoot;
}

describe("wiki project link (CLI)", () => {
  test("stamps AGENTS.md and CLAUDE.md when both are absent", async () => {
    const repoDir = await makeTempDir();
    const vaultRoot = await createProjectVault("acme");

    const result = await runWiki(["project", "link", "--repo", repoDir, "--project", "acme"], vaultRoot);

    expect(result.exitCode).toBe(0);

    const agents = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    const claude = await readFile(join(repoDir, "CLAUDE.md"), "utf8");
    expect(agents).toContain("<!-- wiki:begin");
    expect(claude).toContain("<!-- wiki:begin");
  });

  test("records repo path in _project.md as linked_repos list", async () => {
    const repoDir = await makeTempDir();
    const vaultRoot = await createProjectVault("acme");

    await runWiki(["project", "link", "--repo", repoDir, "--project", "acme"], vaultRoot);

    const raw = await readFile(join(vaultRoot, "projects", "acme", "_project.md"), "utf8");
    const parsed = matter(raw);
    const linked = parsed.data.linked_repos as string[] | undefined;
    expect(Array.isArray(linked)).toBe(true);
    expect(linked).toContain(repoDir);
  });

  test("re-running link is idempotent (one block each, repo listed once)", async () => {
    const repoDir = await makeTempDir();
    const vaultRoot = await createProjectVault("acme");

    await runWiki(["project", "link", "--repo", repoDir, "--project", "acme"], vaultRoot);
    await runWiki(["project", "link", "--repo", repoDir, "--project", "acme"], vaultRoot);

    const agents = await readFile(join(repoDir, "AGENTS.md"), "utf8");
    const beginCount = (agents.match(/<!-- wiki:begin/g) ?? []).length;
    expect(beginCount).toBe(1);

    const raw = await readFile(join(vaultRoot, "projects", "acme", "_project.md"), "utf8");
    const parsed = matter(raw);
    const linked = parsed.data.linked_repos as string[];
    const count = linked.filter((r) => r === repoDir).length;
    expect(count).toBe(1);
  });

  test("exits 1 when --repo is missing", async () => {
    const vaultRoot = await createProjectVault("acme");
    const result = await runWiki(["project", "link", "--project", "acme"], vaultRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--repo");
  });

  test("exits 1 when --project is missing", async () => {
    const repoDir = await makeTempDir();
    const vaultRoot = await createProjectVault("acme");
    const result = await runWiki(["project", "link", "--repo", repoDir], vaultRoot);
    expect(result.exitCode).toBe(1);
  });
});
