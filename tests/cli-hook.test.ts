import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hookGuidance } from "../src/cli/verbs/hooks";

const tempPaths: string[] = [];
const repoRoot = import.meta.dir.replace(/\/tests$/, "");

/** Spawn the CLI, feeding `stdin` and overriding HOME (for install targets). */
async function runWiki(
  args: string[],
  opts: { stdin?: string; home?: string; cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...(opts.home === undefined ? {} : { HOME: opts.home }) },
    stdin: opts.stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout };
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
