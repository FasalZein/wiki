import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { getConfig } from "../src/config/config";
import { detectHarness } from "../src/config/harness";
import { assertProjectStructure, resolveCurrentProject } from "../src/config/project";
import { getVaultRoot } from "../src/config/vault";

const originalEnv = { ...process.env };
const tempPaths: string[] = [];

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("vault config", () => {
  test("getVaultRoot resolves the vault path from KNOWLEDGE_VAULT_ROOT first", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    expect(await getVaultRoot()).toBe(vaultRoot);
  });

  test("getVaultRoot falls back to config file vault.root when env var is unset", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(home, vaultRoot);
    delete process.env.KNOWLEDGE_VAULT_ROOT;
    process.env.HOME = home;
    const configDir = join(home, ".config", "wiki");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.toml"), `[vault]\nroot = "${vaultRoot}"\n`);

    expect(await getVaultRoot()).toBe(vaultRoot);
  });

  test("getVaultRoot fails clearly when no vault root is configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    delete process.env.KNOWLEDGE_VAULT_ROOT;
    process.env.HOME = home;
    const configDir = join(home, ".config", "wiki");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.toml"), "[research]\nsources = []\n");

    await expect(getVaultRoot()).rejects.toThrow(
      "Vault root not configured: set KNOWLEDGE_VAULT_ROOT or ~/.config/wiki/config.toml vault.root",
    );
  });

  test("getVaultRoot expands tilde to the user's home directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const vaultRoot = join(home, "Knowledge");
    await mkdir(vaultRoot);
    process.env.HOME = home;
    process.env.KNOWLEDGE_VAULT_ROOT = "~/Knowledge";

    expect(await getVaultRoot()).toBe(vaultRoot);
  });

  test("getVaultRoot returns an absolute path and rejects nonexistent roots", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "wiki-work-"));
    tempPaths.push(workDir);
    const vaultRoot = join(workDir, "vault");
    await mkdir(vaultRoot);
    const previousCwd = process.cwd();
    process.chdir(workDir);
    try {
      process.env.KNOWLEDGE_VAULT_ROOT = relative(workDir, vaultRoot);
      expect(await getVaultRoot()).toBe(resolve("vault"));

      process.env.KNOWLEDGE_VAULT_ROOT = "missing-vault";
      await expect(getVaultRoot()).rejects.toThrow(`Vault root does not exist: ${resolve("missing-vault")}`);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("getConfig reads TOML and returns a typed WikiConfig object", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    process.env.HOME = home;
    const configDir = join(home, ".config", "wiki");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.toml"),
      '[vault]\nroot = "/vault"\n\n[research]\nsources = ["~/Research", "~/.pi/artifacts/research"]\n',
    );

    expect(await getConfig()).toEqual({
      vault: { root: "/vault" },
      research: { sources: ["~/Research", "~/.pi/artifacts/research"] },
      harness: { detected: "none" },
    });
  });

  test("getConfig returns defaults when the config file does not exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    process.env.HOME = home;
    process.env.KNOWLEDGE_VAULT_ROOT = "/custom-vault";

    expect(await getConfig()).toEqual({
      vault: { root: "/custom-vault" },
      research: {
        sources: [
          "~/.pi/artifacts/research",
          "~/.codex/artifacts/research",
          "~/.claude/artifacts/research",
          "~/Research",
        ],
      },
      harness: { detected: "none" },
    });
  });

  test("detectHarness returns the harness named by explicit env vars", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    process.env.HOME = home;

    process.env.PI_SESSION_ID = "pi-session";
    expect(detectHarness()).toBe("pi");

    delete process.env.PI_SESSION_ID;
    process.env.PI_AGENT = "1";
    expect(detectHarness()).toBe("pi");

    delete process.env.PI_AGENT;
    process.env.CLAUDECODE = "1";
    expect(detectHarness()).toBe("claude-code");

    delete process.env.CLAUDECODE;
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(detectHarness()).toBe("claude-code");

    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CODEX_HOME = "/tmp/codex";
    expect(detectHarness()).toBe("codex");

    delete process.env.CODEX_HOME;
    process.env.OPENAI_CODEX = "1";
    expect(detectHarness()).toBe("codex");

    delete process.env.OPENAI_CODEX;
    expect(detectHarness()).toBe("none");
  });

  test("detectHarness detects Pi from the fallback marker when explicit env vars are absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    process.env.HOME = home;
    await mkdir(join(home, ".pi"));

    expect(detectHarness()).toBe("pi");
  });

  test("getConfig includes the harness detected at read time", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    process.env.HOME = home;
    process.env.OPENAI_CODEX = "1";

    expect((await getConfig()).harness.detected).toBe("codex");
  });

  test("resolveCurrentProject returns the project name when cwd is inside a project folder", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(vaultRoot);
    const nestedPath = join(vaultRoot, "projects", "wiki-v2", "slices");
    await mkdir(nestedPath, { recursive: true });
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    expect(await resolveCurrentProject(nestedPath)).toBe("wiki-v2");
  });

  test("resolveCurrentProject returns null outside a project folder", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "wiki-outside-"));
    tempPaths.push(vaultRoot, outsidePath);
    await mkdir(join(vaultRoot, "projects"));
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    expect(await resolveCurrentProject(join(vaultRoot, "projects"))).toBeNull();
    expect(await resolveCurrentProject(outsidePath)).toBeNull();
  });

  test("assertProjectStructure verifies required project folders and _project.md", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "wiki-project-"));
    tempPaths.push(projectPath);

    await expect(assertProjectStructure(projectPath)).rejects.toThrow("Project structure missing _project.md");

    await writeFile(join(projectPath, "_project.md"), "# Project\n");
    for (const folder of ["prds", "slices", "adrs", "handovers"]) {
      await mkdir(join(projectPath, folder));
    }

    await expect(assertProjectStructure(projectPath)).resolves.toBeUndefined();
  });
});
