import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../src/bootstrap/doctor";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-pathlinks-"));
  tempPaths.push(dir);
  return dir;
}

/** Write an artifact .md under projects/<project>/<folder>/. */
async function writeArtifact(
  vaultRoot: string,
  project: string,
  folder: string,
  filename: string,
  body: string,
): Promise<void> {
  const dir = join(vaultRoot, "projects", project, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), body);
}

describe("doctor path-qualified wikilink check", () => {
  test("flags a path-qualified link to a NONEXISTENT target", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nSee [[projects/demo/prds/PRD-0099-missing]] for details.\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles.length).toBeGreaterThanOrEqual(1);
    expect(
      dangles.some((i) => i.message.includes("projects/demo/prds/PRD-0099-missing")),
    ).toBe(true);
  });

  test("does NOT flag a path-qualified link to an EXISTING target", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nSee [[projects/demo/prds/PRD-0002-bar]] for details.\n",
    );
    // Create the target file (without .md extension in the link, but file has .md)
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0002-bar.md",
      "---\nid: PRD-0002\ntitle: Bar\n---\n# Bar\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter(
      (i) => i.type === "dangling-link" && i.message.includes("PRD-0002-bar"),
    );
    expect(dangles).toHaveLength(0);
  });

  test("does NOT flag a relative cross-project path link (contains ..)", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nShared decision: [[../../other-project/adrs/ADR-0050]].\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles).toHaveLength(0);
  });

  test("still skips a bare cross-prefix id (e.g. [[JIRA-1234]])", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nExternal: [[JIRA-1234]].\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles).toHaveLength(0);
  });

  test("existing bare-id dangling detection still works", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nSee [[PRD-9999]] for more.\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles.some((i) => i.message.includes("PRD-9999"))).toBe(true);
  });

  test("handles path links with |alias suffix correctly", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nSee [[projects/demo/prds/PRD-0099-missing|PRD-0099 Missing]] for details.\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles.length).toBeGreaterThanOrEqual(1);
    expect(
      dangles.some((i) => i.message.includes("projects/demo/prds/PRD-0099-missing")),
    ).toBe(true);
  });

  test("handles path links with #heading suffix correctly", async () => {
    const vaultRoot = await makeTempDir();
    // Target exists, link has #heading — should NOT flag
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-foo.md",
      "---\nid: PRD-0001\ntitle: Foo\n---\n# Foo\n\nSee [[projects/demo/prds/PRD-0002-bar#overview]] for details.\n",
    );
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0002-bar.md",
      "---\nid: PRD-0002\ntitle: Bar\n---\n# Bar\n## Overview\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter(
      (i) => i.type === "dangling-link" && i.message.includes("PRD-0002-bar"),
    );
    expect(dangles).toHaveLength(0);
  });
});
