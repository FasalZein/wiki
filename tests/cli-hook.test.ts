import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { hookGuidance } from "../src/cli/verbs/hooks";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

/** Spawn the CLI, feeding `stdin` and overriding HOME / vault root. Defaults the
 *  vault to a throwaway temp dir so no test ever writes the real $HOME/Knowledge. */
async function runWiki(
  args: string[],
  opts: { stdin?: string; home?: string; cwd?: string; vaultRoot?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let vaultRoot = opts.vaultRoot;
  if (vaultRoot === undefined) {
    vaultRoot = await mkdtemp(join(tmpdir(), "wiki-novault-"));
    tempPaths.push(vaultRoot);
  }
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot, ...(opts.home === undefined ? {} : { HOME: opts.home }) },
    stdin: opts.stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repoDir(project: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-hook-"));
  tempPaths.push(dir);
  if (project !== null) {
    await writeFile(join(dir, "AGENTS.md"), `<!-- wiki:begin v2 project=${project} -->\n<!-- wiki:end -->\n`);
  }
  return dir;
}

describe("hookGuidance (skill → artifact persistence)", () => {
  test("a registered skill yields a create reminder for its kind and the linked project", async () => {
    const out = await hookGuidance("to-slices", await repoDir("wiki-v2"));
    expect(out).toContain("wiki create slice --project wiki-v2 --body -");
  });

  test("an unregistered skill yields no guidance (no injection)", async () => {
    expect(await hookGuidance("some-other-skill", await repoDir("wiki-v2"))).toBeNull();
  });

  test("a registered skill in an unlinked repo prompts for --project", async () => {
    const out = await hookGuidance("handoff", await repoDir(null));
    expect(out).toContain("wiki create handoff --project <name> --body -");
  });
});

describe("wiki hooks run (callback)", () => {
  test("a /skill slash-command in a prompt injects guidance", async () => {
    const cwd = await repoDir("wiki-v2");
    const { stdout } = await runWiki(["hooks", "run"], {
      cwd,
      stdin: JSON.stringify({ prompt: "now /to-slices the PRD", hook_event_name: "UserPromptSubmit" }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("wiki create slice");
  });

  test("a bare prose mention of a skill name does NOT trigger (no false positive)", async () => {
    const { stdout } = await runWiki(["hooks", "run"], {
      stdin: JSON.stringify({ prompt: "let's talk about to-slices and handoff strategy" }),
    });
    expect(stdout).toBe("{}");
  });

  test("a Stop/SessionEnd event injects a stateless blanket persist reminder", async () => {
    const { stdout } = await runWiki(["hooks", "run"], {
      stdin: JSON.stringify({ hook_event_name: "Stop" }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(out.hookSpecificOutput.additionalContext).toContain("wiki create");
  });
});

describe("wiki hooks run (write-signal capture, ADR-0038)", () => {
  /** A minimal vault with one project's folder skeleton, so capture can file. */
  async function fixtureVault(project: string): Promise<string> {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(vaultRoot);
    const projectPath = join(vaultRoot, "projects", project);
    for (const dir of ["prds", "slices", "adrs", "handoffs", "docs"]) {
      await mkdir(join(projectPath, dir), { recursive: true });
    }
    await writeFile(join(projectPath, "_project.md"), `---\n---\n# ${project}\n`);
    return vaultRoot;
  }

  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wiki-write-"));
    tempPaths.push(dir);
    return dir;
  }

  async function lsKind(vaultRoot: string, project: string, folder: string): Promise<string[]> {
    return (await readdir(join(vaultRoot, "projects", project, folder)).catch(() => [] as string[])).filter((f) =>
      f.endsWith(".md"),
    );
  }

  test("a PostToolUse write of a known-kind artifact files it into the vault under that kind", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: slice\nproject: wiki-v2\ntitle: Draft Slice\n---\n# Draft Slice\n\nbody\n");
    const { stdout } = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { path: file } }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("slice");
    const filed = await lsKind(vaultRoot, "wiki-v2", "slices");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatch(/^SLICE-\d{4}-draft-slice\.md$/);
  });

  test("capture is idempotent: re-firing on the same draft does not double-create", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: prd\nproject: wiki-v2\ntitle: Idempotent PRD\n---\n# Idempotent PRD\n");
    const payload = JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: file } });
    await runWiki(["hooks", "run"], { vaultRoot, stdin: payload });
    await runWiki(["hooks", "run"], { vaultRoot, stdin: payload });
    const filed = await lsKind(vaultRoot, "wiki-v2", "prds");
    expect(filed).toHaveLength(1);
  });

  test("a PostToolUse write to an unrelated file yields no capture and files nothing", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const dir = await tmpDir();
    const file = join(dir, "index.ts");
    await writeFile(file, "export const x = 1;\n");
    const { stdout } = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: file } }),
    });
    expect(stdout).toBe("{}");
    expect(await lsKind(vaultRoot, "wiki-v2", "slices")).toHaveLength(0);
  });

  test("an artifact-shaped write whose frontmatter names no kind warns and is NOT captured", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const dir = await tmpDir();
    const file = join(dir, "notes.md");
    await writeFile(file, "---\nid: XYZ-001\ntitle: Notes\n---\n# Notes\n");
    const { stdout, stderr } = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: file } }),
    });
    expect(stdout).toBe("{}");
    expect(stderr).toContain("authored but not captured");
    expect(stderr).toContain("notes.md");
  });

  test("a known-kind artifact with no resolvable project warns and is NOT captured", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const dir = await tmpDir();
    const file = join(dir, "PRD-0099-thing.md");
    await writeFile(file, "---\nid: PRD-0099\ntitle: Thing\n---\n# Thing\n");
    const { stdout, stderr } = await runWiki(["hooks", "run"], {
      vaultRoot,
      cwd: dir, // unlinked cwd: no project frontmatter, no pointer block
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: file } }),
    });
    expect(stdout).toBe("{}");
    expect(stderr).toContain("authored but not captured");
    expect(stderr).toContain("no project");
  });

  test("a known-kind artifact resolves its project from the linked repo when frontmatter omits it", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const repo = await tmpDir();
    await writeFile(join(repo, "AGENTS.md"), "<!-- wiki:begin v2 project=wiki-v2 -->\n<!-- wiki:end -->\n");
    const file = join(repo, "PRD-0099-thing.md");
    await writeFile(file, "---\nid: PRD-0099\ntitle: Thing\n---\n# Thing\n");
    const { stdout } = await runWiki(["hooks", "run"], {
      vaultRoot,
      cwd: repo,
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: file }, cwd: repo }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("prd");
    const filed = await lsKind(vaultRoot, "wiki-v2", "prds");
    expect(filed).toHaveLength(1);
    // the captured artifact's frontmatter carries the resolved project
    const captured = await readFile(join(vaultRoot, "projects", "wiki-v2", "prds", filed[0]!), "utf8");
    expect(matter(captured).data.project).toBe("wiki-v2");
  });
});

describe("wiki hooks install", () => {
  test("writes the runtime config and preserves unrelated keys, deduping on re-run", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    // pre-existing settings that must survive the merge
    await writeFile(join(home, ".claude-existing.json"), "");
    const settings = join(home, ".claude", "settings.json");
    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });

    const first = JSON.parse(await readFile(settings, "utf8"));
    expect(first.hooks.PreToolUse[0].matcher).toBe("Skill");
    expect(first.hooks.PreToolUse[0].hooks[0].command).toBe("wiki hooks run");

    // a Stop entry is written alongside the skill entry
    expect(first.hooks.Stop[0].hooks[0].command).toBe("wiki hooks run");

    // re-run must not append a duplicate entry
    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });
    const second = JSON.parse(await readFile(settings, "utf8"));
    expect(second.hooks.PreToolUse).toHaveLength(1);
    expect(second.hooks.Stop).toHaveLength(1);
  });

  test("a Stop entry is written per runtime", async () => {
    for (const [runtime, file] of [
      ["claude-code", ".claude/settings.json"],
      ["codex", ".codex/hooks.json"],
      ["pi", ".pi/agent/settings.json"],
    ] as const) {
      const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
      tempPaths.push(home);
      await runWiki(["hooks", "install", "--runtime", runtime, "--global"], { home });
      const config = JSON.parse(await readFile(join(home, file), "utf8"));
      const stopEvent = runtime === "claude-code" ? "Stop" : "SessionEnd";
      const wired = (config.hooks[stopEvent] as { hooks?: { command?: string }[] }[]).some((e) =>
        e.hooks?.some((h) => h.command === "wiki hooks run"),
      );
      expect(wired).toBe(true);
    }
  });
});

describe("wiki hooks install (pi bridge detection)", () => {
  test("warns loudly and names @hsingjui/pi-hooks when the bridge is absent from pi packages[]", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const { stderr } = await runWiki(["hooks", "install", "--runtime", "pi", "--global"], { home });
    expect(stderr).toContain("@hsingjui/pi-hooks");
    // disambiguation against the unscoped / forked lookalikes
    expect(stderr.toLowerCase()).toContain("lookalike");
  });

  test("a lookalike pi-hooks in packages[] does NOT satisfy the bridge check", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: ["git:github.com/prateekmedia/pi-hooks"] }),
    );
    const { stderr } = await runWiki(["hooks", "install", "--runtime", "pi", "--global"], { home });
    expect(stderr).toContain("@hsingjui/pi-hooks");
  });

  test("no warning when @hsingjui/pi-hooks is enabled (string or object source)", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: [{ source: "npm:@hsingjui/pi-hooks" }] }),
    );
    const { stderr } = await runWiki(["hooks", "install", "--runtime", "pi", "--global"], { home });
    expect(stderr).not.toContain("bridge missing");
  });
});

describe("wiki hooks uninstall", () => {
  test("splices out only the wiki entry, leaving unrelated hooks/keys intact", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const settings = join(home, ".claude", "settings.json");
    // pre-existing unrelated config that must survive install + uninstall
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      settings,
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool" }] }],
        },
      }),
    );

    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });
    await runWiki(["hooks", "uninstall", "--runtime", "claude-code", "--global"], { home });

    const after = JSON.parse(await readFile(settings, "utf8"));
    expect(after.model).toBe("opus");
    // the unrelated Bash hook survives
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("other-tool");
    // no wiki entry remains anywhere
    const json = JSON.stringify(after);
    expect(json).not.toContain("wiki hooks run");
  });
});

describe("wiki hooks list / status", () => {
  test("report the wired state after install", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });

    const status = await runWiki(["hooks", "status"], { home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("claude-code");
    expect(status.stdout).toContain("wired");

    const list = await runWiki(["hooks", "list"], { home });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("claude-code");
    expect(list.stdout).toContain("wired");
  });
});
