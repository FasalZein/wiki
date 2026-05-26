import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { initVault } from "../src/bootstrap/init";

const MOCK_OBSIDIAN = resolve(import.meta.dir, "fixtures/mock-obsidian.sh");

const tempPaths: string[] = [];

beforeAll(() => {
  process.env.OBSIDIAN_BIN = MOCK_OBSIDIAN;
});

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-vault-init-"));
  tempPaths.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("vault init", () => {
  const expectedDirs = [
    "projects",
    "_templates",
    ".obsidian",
    ".obsidian/plugins",
    ".wiki",
    ".wiki/blessed-config",
  ];

  test("creates all expected directories", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    const result = await initVault(vaultPath);

    for (const dir of expectedDirs) {
      expect(await exists(join(vaultPath, dir))).toBe(true);
    }
    expect(result.path).toBe(vaultPath);
  });

  test("reports created dirs and files in result", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    const result = await initVault(vaultPath);

    for (const dir of expectedDirs) {
      expect(result.created).toContain(dir);
    }
    expect(result.created).toContain(".gitignore");
    expect(result.created).toContain(".wiki/plugin-lock.json");
    expect(result.created).toContain(".git");
    expect(result.skipped).toHaveLength(0);
  });

  test(".gitignore is written with expected exclusion lines", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    await initVault(vaultPath);

    const content = await readFile(join(vaultPath, ".gitignore"), "utf8");
    expect(content).toContain(".obsidian/workspace.json");
    expect(content).toContain(".obsidian/workspace-mobile.json");
    expect(content).toContain(".smart-env/");
    expect(content).toContain(".obsidian/plugins/*/data.json.bak");
  });

  test(".git/ exists after init", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    await initVault(vaultPath);

    expect(await exists(join(vaultPath, ".git"))).toBe(true);
  });

  test(".wiki/plugin-lock.json exists with version 1 and empty plugins", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    await initVault(vaultPath);

    const raw = await readFile(join(vaultPath, ".wiki", "plugin-lock.json"), "utf8");
    const lock = JSON.parse(raw);
    expect(lock.version).toBe(1);
    expect(lock.plugins).toEqual({});
  });

  test("running init on an existing vault does NOT overwrite .gitignore", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    await initVault(vaultPath);

    const customContent = "# custom gitignore\nnode_modules/\n";
    await writeFile(join(vaultPath, ".gitignore"), customContent);

    const result = await initVault(vaultPath);

    const content = await readFile(join(vaultPath, ".gitignore"), "utf8");
    expect(content).toBe(customContent);
    expect(result.skipped).toContain(".gitignore");
  });

  test("running init on an existing vault does NOT fail — skips existing dirs", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    await initVault(vaultPath);

    const result = await initVault(vaultPath);

    expect(result.path).toBe(vaultPath);
    for (const dir of expectedDirs) {
      expect(result.skipped).toContain(dir);
    }
    expect(result.skipped).toContain(".gitignore");
    expect(result.skipped).toContain(".wiki/plugin-lock.json");
    expect(result.skipped).toContain(".git");
  });

  test("running init on a dir that already has .git/ does NOT re-init git", async () => {
    const vaultPath = join(await makeTempDir(), "my-vault");
    await initVault(vaultPath);

    // Create a file and commit so we can verify git state isn't reset
    await writeFile(join(vaultPath, "marker.txt"), "exists");
    const addProc = Bun.spawn(["git", "add", "marker.txt"], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await addProc.exited;
    const commitProc = Bun.spawn(["git", "commit", "-m", "marker"], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await commitProc.exited;

    const result = await initVault(vaultPath);

    expect(result.skipped).toContain(".git");

    // Verify the commit still exists (git wasn't re-initialized)
    const logProc = Bun.spawn(["git", "log", "--oneline"], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const logOutput = await new Response(logProc.stdout).text();
    await logProc.exited;
    expect(logOutput).toContain("marker");
  });
});
