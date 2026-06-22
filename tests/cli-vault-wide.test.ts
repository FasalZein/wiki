import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

type Fixture = { vaultRoot: string; env: Record<string, string> };

async function makeVault(projects: string[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-vaultwide-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  for (const p of projects) {
    const pp = join(vaultRoot, "projects", p);
    for (const f of ["prds", "slices", "adrs", "handoffs", "docs"]) await mkdir(join(pp, f), { recursive: true });
    await writeFile(join(pp, "_project.md"), `---\nproject: ${p}\nrepo: /tmp/${p}\ntest_command: bun test\n---\n`);
  }
  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const resultsFile = join(root, "qmd-results.json");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(resultsFile, "[]");
  await writeFile(qmdCommand, `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list) [ -f "$REGISTERED_FILE" ] && cat "$REGISTERED_FILE" || true ;;
      add) shift 2; while [ $# -gt 0 ]; do if [ "$1" = "--name" ]; then echo "$2 (qmd://$2/)" >> "$REGISTERED_FILE"; break; fi; shift; done ;;
    esac ;;
  query) cat "$RESULTS_FILE" ;;
esac
`);
  await chmod(qmdCommand, 0o755);
  return {
    vaultRoot,
    env: { QMD_COMMAND: qmdCommand, STATE_FILE: stateFile, REGISTERED_FILE: registeredFile, RESULTS_FILE: resultsFile },
  };
}

/**
 * Build a vault where each project pins its own qmd_command in _project.md, and
 * (deliberately) does NOT set QMD_COMMAND in the env — so the vault-wide search
 * guard that requires a single binary is actually exercised. A working fake qmd
 * is exposed as env.FAKE_QMD for the "explicit override" case.
 */
async function makeVaultWithQmd(projectQmd: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-vaultwide-qmd-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  for (const [p, qmd] of Object.entries(projectQmd)) {
    const pp = join(vaultRoot, "projects", p);
    for (const f of ["prds", "slices", "adrs", "handoffs", "docs"]) await mkdir(join(pp, f), { recursive: true });
    await writeFile(join(pp, "_project.md"), `---\nproject: ${p}\nrepo: /tmp/${p}\ntest_command: bun test\nqmd_command: ${qmd}\n---\n`);
  }
  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const resultsFile = join(root, "qmd-results.json");
  const fakeQmd = join(root, "fake-qmd");
  await writeFile(resultsFile, "[]");
  await writeFile(fakeQmd, `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list) [ -f "$REGISTERED_FILE" ] && cat "$REGISTERED_FILE" || true ;;
      add) shift 2; while [ $# -gt 0 ]; do if [ "$1" = "--name" ]; then echo "$2 (qmd://$2/)" >> "$REGISTERED_FILE"; break; fi; shift; done ;;
    esac ;;
  query) cat "$RESULTS_FILE" ;;
esac
`);
  await chmod(fakeQmd, 0o755);
  return {
    vaultRoot,
    env: { STATE_FILE: stateFile, REGISTERED_FILE: registeredFile, RESULTS_FILE: resultsFile, FAKE_QMD: fakeQmd },
  };
}

async function runWiki(args: string[], fixture: Fixture, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const repoRoot = import.meta.dir.replace(/\/tests$/, "");
  const cliPath = join(repoRoot, "src", "cli.ts");
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd: cwd ?? repoRoot,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, ...fixture.env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("vault-wide search", () => {
  test("search without --project queries all projects and exits 0", async () => {
    const fx = await makeVault(["alpha", "beta"]);
    await writeFile(String(fx.env.RESULTS_FILE), JSON.stringify([
      { path: "qmd://alpha/docs/DOC-0001.md", score: 0.9, snippet: "hit" },
    ]));
    const result = await runWiki(["search", "anything"], fx);
    expect(result.stderr).not.toContain("missing required field: project");
    expect(result.exitCode).toBe(0);
    // both project collections were registered/queried
    const state = await Bun.file(String(fx.env.STATE_FILE)).text();
    expect(state).toContain("alpha");
    expect(state).toContain("beta");
  });

  test("search with --project still narrows to one project", async () => {
    const fx = await makeVault(["alpha", "beta"]);
    const result = await runWiki(["search", "anything", "--project", "alpha"], fx);
    expect(result.exitCode).toBe(0);
    const state = await Bun.file(String(fx.env.STATE_FILE)).text();
    expect(state).toContain("alpha");
    expect(state).not.toContain("beta");
  });

  test("vault-wide search rejects projects that pin different qmd_command (no QMD_COMMAND override)", async () => {
    const fx = await makeVaultWithQmd({ alpha: "/usr/local/bin/qmd-a", beta: "/usr/local/bin/qmd-b" });
    // No QMD_COMMAND in env, so the per-project qmd_command values must agree.
    const result = await runWiki(["search", "anything"], fx);
    expect(result.exitCode).toBe(10);
    expect(result.stderr).toContain("vault-wide search needs a single qmd_command");
    expect(result.stderr).toContain("--project");
  });

  test("explicit QMD_COMMAND overrides divergent per-project qmd_command", async () => {
    const fx = await makeVaultWithQmd({ alpha: "/usr/local/bin/qmd-a", beta: "/usr/local/bin/qmd-b" });
    // Pin one binary via env; divergence in config no longer matters.
    const result = await runWiki(["search", "anything"], { ...fx, env: { ...fx.env, QMD_COMMAND: String(fx.env.FAKE_QMD) } });
    expect(result.exitCode).toBe(0);
  });
});

describe("vault-wide status", () => {
  test("bare status with no cwd session summarizes the vault (lists projects)", async () => {
    const fx = await makeVault(["alpha", "beta"]);
    // Run from a neutral cwd (the vault root) that has no .wiki/state session.
    const result = await runWiki(["status"], fx, fx.vaultRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("beta");
  });
});
