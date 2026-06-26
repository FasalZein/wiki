import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { getConfig } from "../src/config/config";
import { assertProjectStructure as _assertProjectStructure } from "../src/config/project";
import { getVaultRoot } from "../src/config/vault";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

const assertProjectStructure = (projectPath: string) => _assertProjectStructure(projectPath, DEFAULT_STRUCTURE);

const originalEnv = { ...process.env };
const tempPaths: string[] = [];

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CLAUDECODE;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.PI_SESSION_ID;
  delete process.env.PI_AGENT;
  delete process.env.CODEX_HOME;
  delete process.env.OPENAI_CODEX;
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
      '[vault]\nroot = "/vault"\n',
    );

    expect(await getConfig()).toEqual({
      vault: { root: "/vault" },
    });
  });

  test("getConfig returns defaults when the config file does not exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    process.env.HOME = home;
    process.env.KNOWLEDGE_VAULT_ROOT = "/custom-vault";

    expect(await getConfig()).toEqual({
      vault: { root: "/custom-vault" },
    });
  });

  test("assertProjectStructure verifies required project folders and _project.md", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "wiki-project-"));
    tempPaths.push(projectPath);

    await expect(assertProjectStructure(projectPath)).rejects.toThrow("Project structure missing _project.md");

    await writeFile(join(projectPath, "_project.md"), "# Project\n");
    for (const folder of ["prds", "slices", "adrs", "handoffs", "docs"]) {
      await mkdir(join(projectPath, folder));
    }

    await expect(assertProjectStructure(projectPath)).resolves.toBeUndefined();
  });
});
