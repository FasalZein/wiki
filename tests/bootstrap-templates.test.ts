import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployTemplates } from "../src/bootstrap/templates";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-templates-"));
  tempPaths.push(dir);
  return dir;
}

describe("deployTemplates", () => {
  test("copies all .md files from source to destination", async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();

    await writeFile(join(src, "decision.md"), "# Decision");
    await writeFile(join(src, "prd.md"), "# PRD");
    await writeFile(join(src, "slice.md"), "# Slice");

    const result = await deployTemplates(src, dest);

    const destFiles = await readdir(dest);
    expect(destFiles.sort()).toEqual(["decision.md", "prd.md", "slice.md"]);
    expect(result.deployed.sort()).toEqual(["decision.md", "prd.md", "slice.md"]);
  });

  test("file count matches", async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();

    await writeFile(join(src, "a.md"), "a");
    await writeFile(join(src, "b.md"), "b");

    const result = await deployTemplates(src, dest);

    expect(result.count).toBe(2);
  });

  test("content of deployed files matches source", async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();

    const content = "---\ntitle: Decision\n---\n# Decision Record\nBody here.";
    await writeFile(join(src, "decision.md"), content);

    await deployTemplates(src, dest);

    const deployed = await readFile(join(dest, "decision.md"), "utf8");
    expect(deployed).toBe(content);
  });

  test("existing files in destination ARE overwritten", async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();

    await writeFile(join(dest, "old.md"), "stale content");
    await writeFile(join(src, "old.md"), "fresh content");

    const result = await deployTemplates(src, dest);

    const deployed = await readFile(join(dest, "old.md"), "utf8");
    expect(deployed).toBe("fresh content");
    expect(result.deployed).toContain("old.md");
  });

  test("non-.md files in source are NOT copied", async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();

    await writeFile(join(src, "template.md"), "# Template");
    await writeFile(join(src, "config.json"), '{"key": "value"}');
    await writeFile(join(src, "notes.txt"), "some notes");

    const result = await deployTemplates(src, dest);

    const destFiles = await readdir(dest);
    expect(destFiles).toEqual(["template.md"]);
    expect(result.deployed).toEqual(["template.md"]);
    expect(result.count).toBe(1);
  });

  test("empty source directory results in empty deploy", async () => {
    const src = await makeTempDir();
    const dest = await makeTempDir();

    const result = await deployTemplates(src, dest);

    expect(result.deployed).toEqual([]);
    expect(result.count).toBe(0);

    const destFiles = await readdir(dest);
    expect(destFiles).toHaveLength(0);
  });
});
