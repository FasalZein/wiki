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
  const dir = await mkdtemp(join(tmpdir(), "wiki-iddrift-"));
  tempPaths.push(dir);
  return dir;
}

/** Write an artifact .md with the given frontmatter id under projects/<project>/<folder>/. */
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

describe("doctor duplicate-id check", () => {
  test("flags a frontmatter id mapping to more than one file", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0001-a.md", "---\nid: PRD-0001\ntitle: A\n---\n# A\n");
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0001-b.md", "---\nid: PRD-0001\ntitle: B\n---\n# B\n");

    const result = await runDoctor(vaultRoot);

    const dups = result.issues.filter((i) => i.type === "duplicate-id");
    expect(dups.length).toBeGreaterThanOrEqual(1);
    expect(dups[0]!.message).toContain("PRD-0001");
  });

  test("a project with all-unique ids produces no duplicate-id issues", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0001-a.md", "---\nid: PRD-0001\ntitle: A\n---\n# A\n");
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0002-b.md", "---\nid: PRD-0002\ntitle: B\n---\n# B\n");

    const result = await runDoctor(vaultRoot);

    expect(result.issues.filter((i) => i.type === "duplicate-id")).toHaveLength(0);
  });
});

describe("doctor dangling-link check", () => {
  test("flags a frontmatter link_list value with no target in the project id set", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0001-a.md", "---\nid: PRD-0001\ntitle: A\n---\n# A\n");
    // SLICE-0001 declares parent_prd PRD-0001 (resolves) but blocked_by SLICE-9999 (dangles).
    await writeArtifact(
      vaultRoot,
      "demo",
      "slices",
      "SLICE-0001-x.md",
      "---\nid: SLICE-0001\ntitle: X\nparent_prd: PRD-0001\nblocked_by:\n  - '[[SLICE-9999]]'\n---\n# X\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles.length).toBeGreaterThanOrEqual(1);
    expect(dangles.some((i) => i.message.includes("SLICE-9999"))).toBe(true);
    // The resolvable parent_prd link must NOT be flagged.
    expect(dangles.some((i) => i.message.includes("PRD-0001"))).toBe(false);
  });

  test("flags a dangling [[id]] body wikilink", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-a.md",
      "---\nid: PRD-0001\ntitle: A\n---\n# A\n\nSee [[PRD-0404]] for more.\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles.some((i) => i.message.includes("PRD-0404"))).toBe(true);
  });

  test("does NOT flag a cross-project (path-qualified) wikilink", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-a.md",
      "---\nid: PRD-0001\ntitle: A\n---\n# A\n\nShared decision: [[../../other-project/adrs/ADR-0050]].\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles).toHaveLength(0);
  });

  test("does NOT flag an unknown-prefix (cross-prefix) bare wikilink", async () => {
    const vaultRoot = await makeTempDir();
    await writeArtifact(
      vaultRoot,
      "demo",
      "prds",
      "PRD-0001-a.md",
      "---\nid: PRD-0001\ntitle: A\n---\n# A\n\nExternal ticket: [[JIRA-1234]].\n",
    );

    const result = await runDoctor(vaultRoot);

    const dangles = result.issues.filter((i) => i.type === "dangling-link");
    expect(dangles).toHaveLength(0);
  });
});
