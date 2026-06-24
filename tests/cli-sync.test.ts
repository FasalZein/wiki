import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("sync CLI", () => {
  test("sync refuses (exit 1) when docs/ has a rogue folder, before embedding", async () => {
    const fixture = await createSyncFixture("wiki-v2");
    await mkdir(join(fixture.projectPath, "docs", "cracking"), { recursive: true });
    await writeFile(join(fixture.projectPath, "docs", "cracking", "note.md"), "# raw\n");

    const result = await runWiki(["sync", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a locked category");
    expect(result.stderr).toContain("refusing to sync");
    // gate runs before qmd: no embed should have happened
    expect(await readFile(fixture.stateFile, "utf8").catch(() => "")).not.toContain("embed -c wiki-v2");
  });

  test("sync ensures the project collection, updates, and embeds without stdout", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    const result = await runWiki(["sync", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("synced collection wiki-v2");
    expect(await readFile(fixture.stateFile, "utf8")).toBe(
      `collection list\ncollection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md\nupdate -c wiki-v2\nembed -c wiki-v2\n`,
    );
  });

  test("sync include-research also refreshes the research collection", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    const result = await runWiki(["sync", "--project", "wiki-v2", "--include-research"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFile(fixture.stateFile, "utf8")).toBe(
      `collection list\ncollection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md\nupdate -c wiki-v2\nembed -c wiki-v2\n` +
        `collection list\ncollection add ${fixture.researchPath} --name research --mask **/*.md\nupdate -c research\nembed -c research\n`,
    );
  });

  test("sync skips collection add when the collection already exists", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    expect((await runWiki(["sync", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);
    expect((await runWiki(["sync", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);

    expect(await readFile(fixture.stateFile, "utf8")).toBe(
      `collection list\ncollection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md\nupdate -c wiki-v2\nembed -c wiki-v2\n` +
        "collection list\nupdate -c wiki-v2\nembed -c wiki-v2\n",
    );
  });

  test("sync passes pull and force-embed flags through to QMD", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    const result = await runWiki(["sync", "--project", "wiki-v2", "--pull", "--force-embed"], fixture);

    expect(result.exitCode).toBe(0);
    expect(await readFile(fixture.stateFile, "utf8")).toBe(
      `collection list\ncollection add ${fixture.projectPath} --name wiki-v2 --mask **/*.md\nupdate --pull -c wiki-v2\nembed -f -c wiki-v2\n`,
    );
  });

  test("sync exits 1 when project is missing and the repo isn't linked", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    await withLinkedRepo(null, async (cwd) => {
      const result = await runWiki(["sync"], fixture, cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("missing required field: project");
    });
  });

  // --- linked-repo fallback (SLICE-0052): sync resolves the project like create does ---

  test("sync with a linked repo and no --project syncs the linked project", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    await withLinkedRepo("wiki-v2", async (cwd) => {
      const result = await runWiki(["sync"], fixture, cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("synced collection wiki-v2");
    });
  });

  test("sync --project overrides the linked repo", async () => {
    const fixture = await createSyncFixture("other-proj");

    await withLinkedRepo("wiki-v2", async (cwd) => {
      const result = await runWiki(["sync", "--project", "other-proj"], fixture, cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("synced collection other-proj");
    });
  });

  test("sync writes a per-project index.md listing artifacts; re-run is byte-identical (SLICE-0072)", async () => {
    const fixture = await createSyncFixture("wiki-v2");
    await writeFile(
      join(fixture.projectPath, "slices", "SLICE-0002-b.md"),
      "---\nid: SLICE-0002\ntitle: Second slice\nsummary: The second slice.\nstatus: planned\n---\nbody\n",
    );
    await writeFile(
      join(fixture.projectPath, "slices", "SLICE-0001-a.md"),
      "---\nid: SLICE-0001\ntitle: First slice\nsummary: The first slice.\nstatus: green\n---\nbody\n",
    );
    // grandfathered: no summary field — must render without crashing
    await writeFile(
      join(fixture.projectPath, "prds", "PRD-0001.md"),
      "---\nid: PRD-0001\ntitle: A PRD\nstatus: draft\n---\nbody\n",
    );

    expect((await runWiki(["sync", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);

    const indexPath = join(fixture.projectPath, "index.md");
    const first = await readFile(indexPath, "utf8");
    expect(first).toContain("# wiki-v2 index");
    expect(first).toContain("[[PRD-0001]] A PRD (draft)");
    expect(first).toContain("[[SLICE-0001]] First slice (green) — The first slice.");
    // sorted by kind then id: PRD before SLICE, SLICE-0001 before SLICE-0002
    expect(first.indexOf("PRD-0001")).toBeLessThan(first.indexOf("SLICE-0001"));
    expect(first.indexOf("SLICE-0001")).toBeLessThan(first.indexOf("SLICE-0002"));

    expect((await runWiki(["sync", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);
    expect(await readFile(indexPath, "utf8")).toBe(first);
  });

  test("sync sections index.md by group: frontmatter; ungrouped fall under General (SLICE-0073)", async () => {
    const fixture = await createSyncFixture("wiki-v2");
    await writeFile(
      join(fixture.projectPath, "slices", "SLICE-0001.md"),
      "---\nid: SLICE-0001\ntitle: Grouped slice\nsummary: A grouped slice.\nstatus: green\ngroup: Backend\n---\nbody\n",
    );
    await writeFile(
      join(fixture.projectPath, "prds", "PRD-0001.md"),
      "---\nid: PRD-0001\ntitle: Ungrouped PRD\nsummary: No group here.\nstatus: draft\n---\nbody\n",
    );

    expect((await runWiki(["sync", "--project", "wiki-v2"], fixture)).exitCode).toBe(0);

    const index = await readFile(join(fixture.projectPath, "index.md"), "utf8");
    expect(index).toContain("## Backend");
    expect(index).toContain("## General");
    // grouped artifact under its heading; ungrouped under General (which sorts last)
    expect(index.indexOf("## Backend")).toBeLessThan(index.indexOf("[[SLICE-0001]]"));
    expect(index.indexOf("## General")).toBeLessThan(index.indexOf("[[PRD-0001]]"));
    expect(index.indexOf("## Backend")).toBeLessThan(index.indexOf("## General"));
  });

  test("sync exits 10 and surfaces qmd stderr when qmd fails", async () => {
    const fixture = await createSyncFixture("wiki-v2", { failUpdate: true });

    const result = await runWiki(["sync", "--project", "wiki-v2"], fixture);

    expect(result.exitCode).toBe(10);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake qmd update failed");
  });
});

type SyncFixture = {
  vaultRoot: string;
  projectPath: string;
  researchPath: string;
  stateFile: string;
  env: Record<string, string>;
};

type SyncFixtureOptions = {
  failUpdate?: boolean;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const repoRoot = import.meta.dir.replace(/\/tests$/, "");

/** Create a temp repo dir linked to `project` via a pointer block (or unlinked when null). */
async function withLinkedRepo(project: string | null, fn: (cwd: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "wiki-sync-repo-"));
  tempPaths.push(repo);
  if (project !== null) {
    await writeFile(join(repo, "AGENTS.md"), `<!-- wiki:begin v2 project=${project} -->\n<!-- wiki:end -->\n`);
  }
  await fn(repo);
}

async function runWiki(args: string[], fixture: SyncFixture, cwd: string = repoRoot): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, ...fixture.env },
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

async function createSyncFixture(project: string, options: SyncFixtureOptions = {}): Promise<SyncFixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-sync-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handoffs"));
  await mkdir(join(projectPath, "docs"));
  const researchPath = join(root, "research");
  await mkdir(researchPath);
  await writeFile(
    join(projectPath, "_project.md"),
    `---\nrepo: /tmp/repo\ntest_command: bun test\nresearch_path: ${researchPath}\n---\n`,
  );

  const stateFile = join(root, "qmd-state.log");
  const registeredFile = join(root, "qmd-registered.txt");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list)
        if [ -f "$REGISTERED_FILE" ]; then
          cat "$REGISTERED_FILE"
        fi
        ;;
      add)
        # extract --name value from args
        shift 2
        while [ $# -gt 0 ]; do
          if [ "$1" = "--name" ]; then
            # mirror real qmd's "collection list" shape: "name (qmd://name/)"
            echo "$2 (qmd://$2/)" >> "$REGISTERED_FILE"
            break
          fi
          shift
        done
        ;;
    esac
    ;;
  update)
    if [ "\${FAIL_UPDATE:-}" = "1" ]; then
      echo "fake qmd update failed" >&2
      exit 7
    fi
    ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);

  return {
    vaultRoot,
    projectPath,
    researchPath,
    stateFile,
    env: {
      QMD_COMMAND: qmdCommand,
      STATE_FILE: stateFile,
      REGISTERED_FILE: registeredFile,
      FAIL_UPDATE: options.failUpdate === true ? "1" : "0",
    },
  };
}
