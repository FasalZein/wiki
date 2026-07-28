import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexStaleness, newestMarkdownMtime, writeMarker } from "../src/integrations/qmd-freshness";

// ADR-0047: `qmd update` costs ~1.6s to answer "did anything change?" — a
// question the filesystem answers in ~5ms. The dedup gate asks it before every
// query, so the pre-write refresh is skipped when no markdown in the project is
// newer than the high-water mark a previous refresh recorded.
//
// Every failure mode must bias toward RUNNING the update: a missing marker, an
// unreadable one, or an unwritable cache dir all have to report "stale".

const tempPaths: string[] = [];
const savedCacheHome = process.env.XDG_CACHE_HOME;

afterEach(async () => {
  if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCacheHome;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wiki-freshness-"));
  tempPaths.push(root);
  process.env.XDG_CACHE_HOME = join(root, "cache");
  const projectPath = join(root, "projects", "proj");
  await mkdir(join(projectPath, "notes"), { recursive: true });
  return projectPath;
}

describe("ADR-0047: local staleness check replaces a no-op qmd update", () => {
  test("a project with no marker is stale (the update must run)", async () => {
    const projectPath = await makeProject();
    await writeFile(join(projectPath, "notes", "NOTE-0001-a.md"), "# a\n");

    const { stale, newest } = await indexStaleness(projectPath);

    expect(stale).toBe(true);
    expect(newest).toBeGreaterThan(0);
  });

  test("a marker at the current high-water mark makes the project fresh (update skipped)", async () => {
    const projectPath = await makeProject();
    await writeFile(join(projectPath, "notes", "NOTE-0001-a.md"), "# a\n");

    const first = await indexStaleness(projectPath);
    await writeMarker(projectPath, first.newest);

    expect((await indexStaleness(projectPath)).stale).toBe(false);
  });

  test("a file written after the marker makes the project stale again", async () => {
    const projectPath = await makeProject();
    await writeFile(join(projectPath, "notes", "NOTE-0001-a.md"), "# a\n");
    await writeMarker(projectPath, (await indexStaleness(projectPath)).newest);

    const later = join(projectPath, "notes", "NOTE-0002-b.md");
    await writeFile(later, "# b\n");
    const future = new Date(Date.now() + 5_000);
    await utimes(later, future, future);

    expect((await indexStaleness(projectPath)).stale).toBe(true);
  });

  test("nested folders count — the newest mtime is found at any depth", async () => {
    const projectPath = await makeProject();
    const deep = join(projectPath, "notes", "sub", "deeper");
    await mkdir(deep, { recursive: true });
    const file = join(deep, "NOTE-0003-c.md");
    await writeFile(file, "# c\n");
    const future = new Date(Date.now() + 5_000);
    await utimes(file, future, future);

    expect(await newestMarkdownMtime(projectPath)).toBeGreaterThan(Date.now());
  });

  test("non-markdown and dotfiles never make a project look stale", async () => {
    const projectPath = await makeProject();
    await writeFile(join(projectPath, "notes", "NOTE-0001-a.md"), "# a\n");
    await writeMarker(projectPath, (await indexStaleness(projectPath)).newest);

    const future = new Date(Date.now() + 5_000);
    const ignored = join(projectPath, "notes", "scratch.txt");
    await writeFile(ignored, "not an artifact\n");
    await utimes(ignored, future, future);
    const hidden = join(projectPath, ".obsidian.md");
    await writeFile(hidden, "# hidden\n");
    await utimes(hidden, future, future);

    expect((await indexStaleness(projectPath)).stale).toBe(false);
  });

  test("two vaults holding a same-named project keep separate markers", async () => {
    const one = await makeProject();
    const cacheHome = process.env.XDG_CACHE_HOME;
    const two = await makeProject();
    process.env.XDG_CACHE_HOME = cacheHome; // one shared cache dir, two project paths
    await writeFile(join(one, "notes", "NOTE-0001-a.md"), "# a\n");
    await writeFile(join(two, "notes", "NOTE-0001-a.md"), "# a\n");

    await writeMarker(one, (await indexStaleness(one)).newest);

    expect((await indexStaleness(one)).stale).toBe(false);
    expect((await indexStaleness(two)).stale).toBe(true);
  });

  test("an unwritable cache dir degrades to always-stale, never to a thrown error", async () => {
    const projectPath = await makeProject();
    await writeFile(join(projectPath, "notes", "NOTE-0001-a.md"), "# a\n");
    // A file where the cache DIRECTORY should be: mkdir -p fails, so the marker
    // can never be written and every check must keep reporting stale.
    const cacheHome = join(tempPaths[tempPaths.length - 1] ?? "", "blocked");
    await writeFile(cacheHome, "not a directory\n");
    process.env.XDG_CACHE_HOME = cacheHome;

    await writeMarker(projectPath, Date.now());

    expect((await indexStaleness(projectPath)).stale).toBe(true);
  });

  test("a project with no markdown at all reports mtime 0", async () => {
    const projectPath = await makeProject();

    expect(await newestMarkdownMtime(projectPath)).toBe(0);
  });
});
