import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasVaultDenyPatterns, installClaudeLock } from "../src/bootstrap/claude-lock";

const tempPaths: string[] = [];
let originalConfigDir: string | undefined;

afterEach(async () => {
  // Restore env
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  }
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-claude-lock-"));
  tempPaths.push(dir);
  return dir;
}

function setConfigDir(dir: string): void {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
}

describe("installClaudeLock", () => {
  test("install on empty settings.json adds deny patterns", async () => {
    const tmp = await makeTempDir();
    const claudeDir = join(tmp, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify({}, null, 2));
    setConfigDir(claudeDir);

    const vaultPath = "/fake/vault";
    const result = await installClaudeLock(vaultPath);

    expect(result.status).toBe("installed");

    const settings = JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain(`Edit: ${vaultPath}/**`);
    expect(settings.permissions.deny).toContain(`Write: ${vaultPath}/**`);
    expect(settings.permissions.deny).toContain(`Bash: *${vaultPath}*`);
  });

  test("install on settings.json with existing deny array appends without duplicating", async () => {
    const tmp = await makeTempDir();
    const claudeDir = join(tmp, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const existing = {
      permissions: {
        deny: ["Edit: /other/path/**"],
      },
    };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2));
    setConfigDir(claudeDir);

    const vaultPath = "/fake/vault";
    const result = await installClaudeLock(vaultPath);

    expect(result.status).toBe("installed");

    const settings = JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Edit: /other/path/**");
    expect(settings.permissions.deny).toContain(`Edit: ${vaultPath}/**`);
    expect(settings.permissions.deny).toContain(`Write: ${vaultPath}/**`);
    expect(settings.permissions.deny).toContain(`Bash: *${vaultPath}*`);
    // No duplicates of the existing one
    expect(settings.permissions.deny.filter((d: string) => d === "Edit: /other/path/**")).toHaveLength(1);
  });

  test("install when patterns already present returns already-present", async () => {
    const tmp = await makeTempDir();
    const claudeDir = join(tmp, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const vaultPath = "/fake/vault";
    const existing = {
      permissions: {
        deny: [
          `Edit: ${vaultPath}/**`,
          `Write: ${vaultPath}/**`,
          `Bash: *${vaultPath}*`,
        ],
      },
    };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2));
    setConfigDir(claudeDir);

    const result = await installClaudeLock(vaultPath);

    expect(result.status).toBe("already-present");
  });

  test("missing ~/.claude/ returns not-found with manual instructions", async () => {
    const tmp = await makeTempDir();
    // Point to a dir that does NOT have .claude
    setConfigDir(join(tmp, "nonexistent-claude"));

    const result = await installClaudeLock("/fake/vault");

    expect(result.status).toBe("not-found");
    expect(result.message).toBeDefined();
    expect(result.message!.length).toBeGreaterThan(0);
  });

  test("existing non-deny settings are preserved after install", async () => {
    const tmp = await makeTempDir();
    const claudeDir = join(tmp, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const existing = {
      model: "opus",
      permissions: {
        allow: ["Read: /some/path/**"],
        deny: [],
      },
      customKey: "customValue",
    };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2));
    setConfigDir(claudeDir);

    await installClaudeLock("/fake/vault");

    const settings = JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.permissions.allow).toEqual(["Read: /some/path/**"]);
    expect(settings.customKey).toBe("customValue");
  });

  test("deny patterns include Edit, Write, and Bash patterns for the vault path", async () => {
    const tmp = await makeTempDir();
    const claudeDir = join(tmp, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.json"), "{}");
    setConfigDir(claudeDir);

    const vaultPath = "/my/special/vault";
    await installClaudeLock(vaultPath);

    const settings = JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf8"));
    const deny: string[] = settings.permissions.deny;
    expect(deny).toEqual([
      `Edit: ${vaultPath}/**`,
      `Write: ${vaultPath}/**`,
      `Bash: *${vaultPath}*`,
    ]);
  });

  test("uses $CLAUDE_CONFIG_DIR env var when set", async () => {
    const tmp = await makeTempDir();
    const customDir = join(tmp, "custom-claude-config");
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, "settings.json"), "{}");
    setConfigDir(customDir);

    const result = await installClaudeLock("/fake/vault");

    expect(result.status).toBe("installed");

    const settings = JSON.parse(await readFile(join(customDir, "settings.json"), "utf8"));
    expect(settings.permissions.deny).toBeDefined();
  });
});

describe("hasVaultDenyPatterns", () => {
  test("returns true when all patterns are present", () => {
    const vaultPath = "/fake/vault";
    const settings = {
      permissions: {
        deny: [
          `Edit: ${vaultPath}/**`,
          `Write: ${vaultPath}/**`,
          `Bash: *${vaultPath}*`,
        ],
      },
    };
    expect(hasVaultDenyPatterns(settings, vaultPath)).toBe(true);
  });

  test("returns false when patterns are missing", () => {
    expect(hasVaultDenyPatterns({}, "/fake/vault")).toBe(false);
    expect(hasVaultDenyPatterns({ permissions: {} }, "/fake/vault")).toBe(false);
    expect(hasVaultDenyPatterns({ permissions: { deny: [] } }, "/fake/vault")).toBe(false);
  });

  test("returns false when only some patterns are present", () => {
    const vaultPath = "/fake/vault";
    const settings = {
      permissions: {
        deny: [`Edit: ${vaultPath}/**`],
      },
    };
    expect(hasVaultDenyPatterns(settings, vaultPath)).toBe(false);
  });
});
