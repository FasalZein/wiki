import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateSetup } from "../src/bootstrap/setup-doctor";

const repoRoot = join(import.meta.dir, "..");
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

describe("dist is relocatable (templates bundled)", () => {
  test("a built cli.js moved outside the repo still loads templates", async () => {
    const buildDir = await tmp("wiki-reloc-");
    // Build the bundle into a temp outdir and copy templates beside it, mirroring `bun run build`.
    const build = Bun.spawn(["bun", "build", join(repoRoot, "src", "cli.ts"), "--outdir", buildDir, "--target", "bun"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await build.exited).toBe(0);
    await cp(join(repoRoot, "templates"), join(buildDir, "templates"), { recursive: true });

    // Relocate the whole bundle far from the repo, so the dev-mode src fallback cannot resolve.
    const elsewhere = await tmp("wiki-elsewhere-");
    const relocated = join(elsewhere, "bin");
    await cp(buildDir, relocated, { recursive: true });

    const run = Bun.spawn(["bun", join(relocated, "cli.js"), "schema", "prd"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(run.stdout).text(), run.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("prd fields:");
  }, 30_000);
});

describe("doctor --setup distribution health", () => {
  async function freshBinary(): Promise<{ binaryPath: string; srcDir: string }> {
    const root = await tmp("wiki-setup-");
    const srcDir = join(root, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "a.ts"), "x");
    const binaryPath = join(root, "cli.js");
    await writeFile(binaryPath, "bin");
    // Make the binary newer than the source.
    const srcMtime = (await stat(join(srcDir, "a.ts"))).mtimeMs / 1000;
    await utimes(binaryPath, srcMtime + 100, srcMtime + 100);
    return { binaryPath, srcDir };
  }

  test("clean when binary is fresh, bundle present, hook wired", async () => {
    const { binaryPath, srcDir } = await freshBinary();
    const bundle = join(await tmp("wiki-bundle-"), "SKILL.md");
    await writeFile(bundle, "skill");
    const result = await evaluateSetup({ binaryPath, srcDir, skillBundlePath: bundle, hookWired: true });
    expect(result.clean).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("reports a stale binary when source is newer than the build", async () => {
    const { binaryPath, srcDir } = await freshBinary();
    const bundle = join(await tmp("wiki-bundle-"), "SKILL.md");
    await writeFile(bundle, "skill");
    // Touch a source file to the future so it outpaces the binary.
    const future = Date.now() / 1000 + 10_000;
    await utimes(join(srcDir, "a.ts"), future, future);
    const result = await evaluateSetup({ binaryPath, srcDir, skillBundlePath: bundle, hookWired: true });
    expect(result.clean).toBe(false);
    expect(result.issues.map((i) => i.type)).toContain("stale-binary");
  });

  test("reports a missing skill bundle", async () => {
    const { binaryPath, srcDir } = await freshBinary();
    const result = await evaluateSetup({
      binaryPath,
      srcDir,
      skillBundlePath: join(await tmp("wiki-nobundle-"), "absent", "SKILL.md"),
      hookWired: true,
    });
    expect(result.clean).toBe(false);
    expect(result.issues.map((i) => i.type)).toContain("missing-bundle");
  });

  test("reports an unwired hook", async () => {
    const { binaryPath, srcDir } = await freshBinary();
    const bundle = join(await tmp("wiki-bundle-"), "SKILL.md");
    await writeFile(bundle, "skill");
    const result = await evaluateSetup({ binaryPath, srcDir, skillBundlePath: bundle, hookWired: false });
    expect(result.clean).toBe(false);
    expect(result.issues.map((i) => i.type)).toContain("unwired-hook");
  });

  test("reports subagents whose allowlist cannot reach the bridge, naming them", async () => {
    const { binaryPath, srcDir } = await freshBinary();
    const bundle = join(await tmp("wiki-bundle-"), "SKILL.md");
    await writeFile(bundle, "skill");
    const result = await evaluateSetup({
      binaryPath,
      srcDir,
      skillBundlePath: bundle,
      hookWired: true,
      unreachableSubagents: ["worker", "scout"],
    });
    expect(result.clean).toBe(false);
    const unreachable = result.issues.find((i) => i.type === "unreachable-subagent");
    expect(unreachable).toBeDefined();
    expect(unreachable!.message).toContain("worker");
    expect(unreachable!.message).toContain("scout");
  });

  test("clean when every subagent allowlist reaches the bridge", async () => {
    const { binaryPath, srcDir } = await freshBinary();
    const bundle = join(await tmp("wiki-bundle-"), "SKILL.md");
    await writeFile(bundle, "skill");
    const result = await evaluateSetup({
      binaryPath,
      srcDir,
      skillBundlePath: bundle,
      hookWired: true,
      unreachableSubagents: [],
    });
    expect(result.clean).toBe(true);
    expect(result.issues.map((i) => i.type)).not.toContain("unreachable-subagent");
  });
});
