import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArtifact as _createArtifact } from "../src/artifacts/store";
import { withProjectLock } from "../src/artifacts/lock";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// SLICE-0121: the per-project allocation lock lives INSIDE mintAndWrite, so it is
// exercised through createArtifact. These tests use a TEMP vault only.
const createArtifact = (input: Omit<Parameters<typeof _createArtifact>[0], "structure">) =>
  _createArtifact({ ...input, structure: DEFAULT_STRUCTURE });

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-lock-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  return vaultRoot;
}

const makePrd = (vault: string, project: string, title: string) =>
  createArtifact({
    type: "prd",
    vaultRoot: vault,
    project,
    fields: { title, summary: "A populated summary here." },
  });

describe("per-project allocation lock", () => {
  test("two concurrent DIFFERENT-title creates in one project get distinct ids", async () => {
    // The key duplicate-id race: distinct titles render distinct PATHS, so the
    // `wx` exclusive write never collides — without the lock BOTH would mint the
    // same id and silently file a duplicate. The lock serializes allocate->write
    // so the second create sees the first file and bumps the id.
    const vault = await createVault("test");
    const [a, b] = await Promise.all([
      makePrd(vault, "test", "Alpha feature"),
      makePrd(vault, "test", "Beta feature"),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(new Set([a.id, b.id])).toEqual(new Set(["PRD-0001", "PRD-0002"]));
    expect(await Bun.file(a.path).exists()).toBe(true);
    expect(await Bun.file(b.path).exists()).toBe(true);
  });

  test("many concurrent creates in one project all get distinct ids", async () => {
    const vault = await createVault("test");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makePrd(vault, "test", `Feature ${i}`)),
    );
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  test("creates in DIFFERENT projects do not contend (each starts at 0001)", async () => {
    const vault = await createVault("alpha");
    await mkdir(join(vault, "projects", "beta", "prds"), { recursive: true });

    const [a, b] = await Promise.all([
      makePrd(vault, "alpha", "Alpha project feature"),
      makePrd(vault, "beta", "Beta project feature"),
    ]);
    // Different projects hold different lockfiles, so both allocate independently.
    expect(a.id).toBe("PRD-0001");
    expect(b.id).toBe("PRD-0001");
  });

  test("a stale lockfile past the timeout is reclaimed (no deadlock)", async () => {
    const vault = await createVault("test");
    // Simulate a crashed writer: a lockfile with an old mtime. The acquire path
    // reclaims it instead of hanging until ACQUIRE_TIMEOUT_MS.
    const lockDir = join(vault, ".wiki", "locks");
    await mkdir(lockDir, { recursive: true });
    const lock = join(lockDir, "test.lock");
    await writeFile(lock, "stale");
    const old = new Date(Date.now() - 60_000);
    await Bun.spawn(["touch", "-t", formatTouch(old), lock]).exited;

    const result = await makePrd(vault, "test", "After crash");
    expect(result.id).toBe("PRD-0001");
    // Lock released after the write — no lingering lockfile.
    expect(await Bun.file(lock).exists()).toBe(false);
  });

  test("lockfile lives under .wiki/, never inside projects/", async () => {
    const vault = await createVault("test");
    let projectEntriesDuringWrite: string[] = [];
    await withProjectLock(vault, "test", async () => {
      projectEntriesDuringWrite = await readdir(join(vault, "projects", "test"));
      // The lock must exist while held...
      expect(await Bun.file(join(vault, ".wiki", "locks", "test.lock")).exists()).toBe(true);
    });
    // ...and not be mixed into the project's artifact tree.
    expect(projectEntriesDuringWrite).not.toContain("test.lock");
    expect((await stat(join(vault, ".wiki", "locks"))).isDirectory()).toBe(true);
  });
});

/** `touch -t` wants [[CC]YY]MMDDhhmm[.ss]. */
function formatTouch(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}.${p(d.getSeconds())}`;
}
