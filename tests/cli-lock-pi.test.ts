import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("lock pi CLI", () => {
  test("print emits deterministic JSON with absolute vault path", async () => {
    const fixture = await createFixture();

    const result = await runWiki(["lock", "pi", "print", "--vault", fixture.relativeVault], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(expectedManifest(fixture.vaultRoot));
    expect(result.stdout).toBe(`${JSON.stringify(expectedManifest(fixture.vaultRoot), null, 2)}\n`);
  });

  test("install writes config and creates parent dirs", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.root, "nested", "pi", "wiki-vault-lock.json");

    const result = await runWiki(["lock", "pi", "install", "--vault", fixture.vaultRoot, "--config", configPath], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${configPath}\n`);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(expectedManifest(fixture.vaultRoot));
    expect((await readdir(join(fixture.root, "nested", "pi"))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("check succeeds after install and fails before install", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.root, "pi-config", "wiki-vault-lock.json");

    const missing = await runWiki(["lock", "pi", "check", "--vault", fixture.vaultRoot, "--config", configPath], fixture);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("Config missing");

    expect((await runWiki(["lock", "pi", "install", "--vault", fixture.vaultRoot, "--config", configPath], fixture)).exitCode).toBe(0);
    const check = await runWiki(["lock", "pi", "check", "--vault", fixture.vaultRoot, "--config", configPath], fixture);

    expect(check.exitCode).toBe(0);
    expect(check.stdout).toBe("");
    expect(check.stderr).toBe("");
  });

  test("check fails for wrong vault root and reports mismatches", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.root, "pi-config", "wiki-vault-lock.json");
    const otherVault = join(fixture.root, "other-vault");
    await mkdir(otherVault);
    await mkdir(join(fixture.root, "pi-config"));
    await writeFile(configPath, `${JSON.stringify(expectedManifest(otherVault), null, 2)}\n`);

    const result = await runWiki(["lock", "pi", "check", "--vault", fixture.vaultRoot, "--config", configPath], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Vault root mismatch: expected ${fixture.vaultRoot}`);
    expect(result.stderr).toContain(`Missing deny rule: write ${fixture.vaultRoot}/**`);
  });

  test("doctor prints OK and FAIL summaries", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.root, "pi-config", "wiki-vault-lock.json");

    const fail = await runWiki(["lock", "pi", "doctor", "--vault", fixture.vaultRoot, "--config", configPath], fixture);
    expect(fail.exitCode).toBe(1);
    expect(fail.stdout).toContain("Vault lock: FAIL");
    expect(fail.stdout).toContain("Config missing");

    expect((await runWiki(["lock", "pi", "install", "--vault", fixture.vaultRoot, "--config", configPath], fixture)).exitCode).toBe(0);
    const ok = await runWiki(["lock", "pi", "doctor", "--vault", fixture.vaultRoot, "--config", configPath], fixture);

    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe(`Vault lock: OK\nConfig: ${configPath}\nVault: ${fixture.vaultRoot}\n`);
    expect(ok.stderr).toBe("");
  });

  test("tilde paths expand from HOME", async () => {
    const fixture = await createFixture();
    const home = join(fixture.root, "home");
    const vaultRoot = join(home, "Knowledge");
    await mkdir(vaultRoot, { recursive: true });
    const configPath = "~/pi/wiki-vault-lock.json";

    const result = await runWiki(["lock", "pi", "install", "--vault", "~/Knowledge", "--config", configPath], fixture, { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${join(home, "pi", "wiki-vault-lock.json")}\n`);
    expect(JSON.parse(await readFile(join(home, "pi", "wiki-vault-lock.json"), "utf8"))).toEqual(expectedManifest(vaultRoot));
  });

  test("write and check commands require explicit config and never write real pi config implicitly", async () => {
    const fixture = await createFixture();
    const home = join(fixture.root, "home");
    await mkdir(home);

    const install = await runWiki(["lock", "pi", "install", "--vault", fixture.vaultRoot], fixture, { HOME: home });
    const check = await runWiki(["lock", "pi", "check", "--vault", fixture.vaultRoot], fixture, { HOME: home });

    expect(install.exitCode).toBe(1);
    expect(install.stderr).toContain("missing required field: config");
    expect(check.exitCode).toBe(1);
    expect(check.stderr).toContain("missing required field: config");
    expect(await readdir(home)).not.toContain(".pi");
  });
});

type Fixture = {
  root: string;
  vaultRoot: string;
  relativeVault: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-lock-pi-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  await mkdir(vaultRoot);
  return { root, vaultRoot: await realpath(vaultRoot), relativeVault: "vault" };
}

async function runWiki(args: string[], fixture: Fixture, env: Record<string, string> = {}): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: fixture.root,
    env: { ...process.env, ...env },
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

function expectedManifest(vaultRoot: string): unknown {
  return {
    kind: "wiki-vault-lock/pi",
    version: 1,
    vaultRoot,
    deny: [
      { tool: "write", path: `${vaultRoot}/**` },
      { tool: "edit", path: `${vaultRoot}/**` },
      { tool: "multi_edit", path: `${vaultRoot}/**` },
      { tool: "bash", path: `${vaultRoot}/**`, patterns: [">", ">>", "tee", "cat >", "heredoc"] },
    ],
  };
}
