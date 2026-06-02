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

  test("sync exits 1 when project is missing", async () => {
    const fixture = await createSyncFixture("wiki-v2");

    const result = await runWiki(["sync"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing required field: project");
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

async function runWiki(args: string[], fixture: SyncFixture): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: fixture.vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh"), ...fixture.env },
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
  await mkdir(join(projectPath, "handovers"));
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
