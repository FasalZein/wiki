import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureArtifact } from "../src/artifacts/capture";

// SLICE-0127: the capture path runs the SAME advisory dedup gate `wiki create`
// uses (runDedupGate), inside the per-project lock. Capture is a non-interactive
// hook, so on a STRONG match it FILES the artifact anyway and records an advisory
// "possible duplicate of [[X]] — review" note (surfaced to stderr by the hook);
// it never blocks, prompts, or drops — including on a false-positive match. The
// real $HOME/Knowledge vault is never touched (TEMP vault + a fake qmd binary).

const tempPaths: string[] = [];
const savedVault = process.env.KNOWLEDGE_VAULT_ROOT;
const savedQmd = process.env.QMD_COMMAND;
const savedState = process.env.STATE_FILE;
const savedResults = process.env.RESULTS_FILE;
const savedRegistered = process.env.REGISTERED_FILE;

afterEach(async () => {
  restore("KNOWLEDGE_VAULT_ROOT", savedVault);
  restore("QMD_COMMAND", savedQmd);
  restore("STATE_FILE", savedState);
  restore("RESULTS_FILE", savedResults);
  restore("REGISTERED_FILE", savedRegistered);
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// A custom tree with a single dedup-enabled `bug` kind (prefix BUG, folder bugs).
const customConfig = JSON.stringify({
  kinds: { bug: { prefix: "BUG", folder: "bugs", dedup: true } },
});

type Vault = { vaultRoot: string; project: string; stateFile: string; resultsFile: string };

async function makeVault(project: string): Promise<Vault> {
  const root = await mkdtemp(join(tmpdir(), "wiki-capture-dedup-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "bugs"), { recursive: true });
  await writeFile(join(vaultRoot, "wiki.json"), customConfig);
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: /tmp/repo\ntest_command: bun test\n---\n# ${project}\n`);

  const stateFile = join(root, "qmd-state.log");
  const resultsFile = join(root, "qmd-results.json");
  const registeredFile = join(root, "qmd-registered.txt");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(stateFile, "");
  await writeFile(resultsFile, "[]");
  await writeFile(
    qmdCommand,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "$STATE_FILE"
case "\${1:-}" in
  collection)
    case "\${2:-}" in
      list) [ -f "$REGISTERED_FILE" ] && cat "$REGISTERED_FILE" || true ;;
      add) echo "$3" >> "$REGISTERED_FILE" ;;
    esac
    ;;
  update) : ;;
  query) cat "$RESULTS_FILE" ;;
esac
`,
  );
  await chmod(qmdCommand, 0o755);

  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  process.env.QMD_COMMAND = qmdCommand;
  process.env.STATE_FILE = stateFile;
  process.env.RESULTS_FILE = resultsFile;
  process.env.REGISTERED_FILE = registeredFile;
  return { vaultRoot, project, stateFile, resultsFile };
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-capture-dedup-src-"));
  tempPaths.push(dir);
  return dir;
}

async function lsBugs(vaultRoot: string, project: string): Promise<string[]> {
  return (await readdir(join(vaultRoot, "projects", project, "bugs")).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".md"),
  );
}

describe("SLICE-0127: capture runs the dedup gate and warns-and-files on a strong match", () => {
  test("a strong dedup match files the artifact AND records a 'possible duplicate' note (never drops)", async () => {
    const vault = await makeVault("proj");
    // The fake qmd returns a STRONG match (score 0.9 >= the 0.85 default strong threshold).
    await writeFile(
      vault.resultsFile,
      JSON.stringify([{ path: join(vault.vaultRoot, "projects", "proj", "bugs", "BUG-0007-existing.md"), score: 0.9, snippet: "Same bug" }]),
    );
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: Crash on save\n---\n# Crash on save\n\nthe app crashes when saving\n");

    const outcome = await captureArtifact({ path: file, cwd: dir });

    // Filed anyway — never blocked, never dropped.
    expect(outcome?.outcome).toBe("captured");
    expect(await lsBugs(vault.vaultRoot, "proj")).toHaveLength(1);
    // Advisory note names the matched artifact for review.
    expect(outcome && outcome.outcome === "captured" ? outcome.note : undefined).toBe("possible duplicate of [[BUG-0007]] — review");
  });

  test("the locked critical section order is dedup refresh+query -> write -> qmd update (one lock)", async () => {
    const vault = await makeVault("proj");
    await writeFile(vault.resultsFile, "[]"); // no match this time
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: A new bug\n---\n# A new bug\n\nfresh\n");

    const outcome = await captureArtifact({ path: file, cwd: dir });
    expect(outcome?.outcome).toBe("captured");

    const lines = (await readFile(vault.stateFile, "utf8")).split("\n").filter((l) => l.length > 0);
    const dedupUpdate = lines.findIndex((l) => l.startsWith("update ") && l.includes("-c proj"));
    const query = lines.findIndex((l) => l.startsWith("query "));
    const lastUpdate = lines.map((l) => l.startsWith("update ")).lastIndexOf(true);
    // dedup refresh (update) precedes the dedup query ...
    expect(dedupUpdate).toBeGreaterThanOrEqual(0);
    expect(query).toBeGreaterThanOrEqual(0);
    expect(dedupUpdate).toBeLessThan(query);
    // ... and the write-path keyword update (SLICE-0126) is the LAST qmd touch.
    expect(lastUpdate).toBeGreaterThan(query);
    // qmd was never asked to embed on the capture path.
    expect(lines.some((l) => l.startsWith("embed "))).toBe(false);
  });

  test("a weak match (below the strong threshold) files silently — no note", async () => {
    const vault = await makeVault("proj");
    // 0.75 is >= weak (0.7) but < strong (0.85): advisory-weak, capture stays quiet.
    await writeFile(
      vault.resultsFile,
      JSON.stringify([{ path: join(vault.vaultRoot, "projects", "proj", "bugs", "BUG-0003-old.md"), score: 0.75, snippet: "Maybe related" }]),
    );
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: bug\nproject: proj\ntitle: Weakly similar\n---\n# Weakly similar\n");

    const outcome = await captureArtifact({ path: file, cwd: dir });

    expect(outcome?.outcome).toBe("captured");
    expect(await lsBugs(vault.vaultRoot, "proj")).toHaveLength(1);
    expect(outcome && outcome.outcome === "captured" ? outcome.note : undefined).toBeUndefined();
  });
});
