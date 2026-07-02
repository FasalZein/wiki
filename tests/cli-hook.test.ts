import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    // names the stamp-template authoring step, not only `wiki create` (SLICE-0125)
    expect(out).toContain("template: slice");
    expect(out).toContain("project: wiki-v2");
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

  test("Stop/SessionEnd are always silent — even with outstanding debt (turn end is mid-work by construction)", async () => {
    const cwd = await repoDir("wiki-v2");
    const session = crypto.randomUUID();
    await runWiki(["hooks", "run"], {
      cwd,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "to-slices" }, session_id: session, cwd }),
    });
    for (const event of ["Stop", "SessionEnd"]) {
      const { stdout } = await runWiki(["hooks", "run"], {
        stdin: JSON.stringify({ hook_event_name: event, session_id: session }),
      });
      expect(stdout, `${event} must stay silent`).toBe("{}");
    }
  });

  test("the next UserPromptSubmit after an authoring skill ran (same session) reminds with that skill's kind", async () => {
    const cwd = await repoDir("wiki-v2");
    const session = crypto.randomUUID();
    await runWiki(["hooks", "run"], {
      cwd,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "to-slices" }, session_id: session, cwd }),
    });
    const { stdout } = await runWiki(["hooks", "run"], {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "looks good, continue", session_id: session }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("to-slices");
    expect(out.hookSpecificOutput.additionalContext).toContain("wiki create slice");
    // the reminder names the stamp-template step too (SLICE-0125), not only `wiki create`
    expect(out.hookSpecificOutput.additionalContext).toContain("template: slice");
  });

  test("skill→kind routing is vault-config-driven: a custom kind + skill in the vault's wiki.json routes with no code change", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-customkind-"));
    tempPaths.push(vaultRoot);
    await writeFile(
      join(vaultRoot, "wiki.json"),
      JSON.stringify({
        kinds: {
          incident: { prefix: "INC", folder: "incidents", dedup: false, skill: "postmortem" },
        },
      }),
    );
    const { stdout } = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "postmortem" } }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("wiki 'incident' artifact");
    // and a bundled-default skill is NOT registered in this vault's config, so it stays silent
    const other = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "to-slices" } }),
    });
    expect(other.stdout).toBe("{}");
  });

  test("the persist reminder clears its debt when it fires (once per debt, never a nag loop)", async () => {
    const cwd = await repoDir("wiki-v2");
    const session = crypto.randomUUID();
    await runWiki(["hooks", "run"], {
      cwd,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "handoff" }, session_id: session, cwd }),
    });
    const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "carry on", session_id: session });
    const first = await runWiki(["hooks", "run"], { stdin: payload });
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain("wiki create handoff");
    const second = await runWiki(["hooks", "run"], { stdin: payload });
    expect(second.stdout).toBe("{}");
    // a different session with no debt of its own stays silent
    const other = await runWiki(["hooks", "run"], {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "carry on", session_id: crypto.randomUUID() }),
    });
    expect(other.stdout).toBe("{}");
  });

  test("a captured write clears the persist debt, so the following Stop stays silent", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(vaultRoot);
    const projectPath = join(vaultRoot, "projects", "wiki-v2");
    await mkdir(join(projectPath, "slices"), { recursive: true });
    await writeFile(join(projectPath, "_project.md"), "---\n---\n# wiki-v2\n");
    const cwd = await repoDir("wiki-v2");
    const session = crypto.randomUUID();
    // 1. authoring skill fires → debt recorded
    await runWiki(["hooks", "run"], {
      cwd,
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "to-slices" }, session_id: session, cwd }),
    });
    // 2. a stamped draft is written and captured → debt cleared
    const file = join(cwd, "draft.md");
    await writeFile(file, "---\ntemplate: slice\nproject: wiki-v2\ntitle: Debt Clearing Slice\n---\n# Debt Clearing Slice\n\nbody\n");
    const captured = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: file }, session_id: session, cwd }),
    });
    expect(captured.stdout).toContain("hookSpecificOutput");
    // 3. the next user prompt owes nothing
    const next = await runWiki(["hooks", "run"], {
      stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "next task", session_id: session }),
    });
    expect(next.stdout).toBe("{}");
  });
});

describe("wiki hooks run (real claude-code payload shapes)", () => {
  test("a PreToolUse Skill event carries the skill name in tool_input.skill (not skill_name)", async () => {
    const cwd = await repoDir("wiki-v2");
    const { stdout } = await runWiki(["hooks", "run"], {
      cwd,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: "to-slices", args: "" } }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.additionalContext).toContain("wiki create slice");
  });

  test("the legacy tool_input.skill_name shape still triggers the reminder", async () => {
    const cwd = await repoDir("wiki-v2");
    const { stdout } = await runWiki(["hooks", "run"], {
      cwd,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill_name: "to-slices" } }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("wiki create slice");
  });

  test("a PostToolUse Write payload with file_path/content and tool_response reaches the capture path", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    tempPaths.push(vaultRoot);
    const projectPath = join(vaultRoot, "projects", "wiki-v2");
    await mkdir(join(projectPath, "slices"), { recursive: true });
    await writeFile(join(projectPath, "_project.md"), "---\n---\n# wiki-v2\n");
    const dir = await mkdtemp(join(tmpdir(), "wiki-write-"));
    tempPaths.push(dir);
    const file = join(dir, "draft.md");
    const content = "---\ntemplate: slice\nproject: wiki-v2\ntitle: Draft Slice\n---\n# Draft Slice\n\nbody\n";
    await writeFile(file, content);
    const { stdout } = await runWiki(["hooks", "run"], {
      vaultRoot,
      // full Write PostToolUse shape: tool_input carries file_path + content; tool_response is the tool's output
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: file, content },
        tool_response: { filePath: file, success: true },
      }),
    });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("slice");
    const filed = (await readdir(join(projectPath, "slices"))).filter((f) => f.endsWith(".md"));
    expect(filed).toHaveLength(1);
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

  test("a filesystem fault stamping a read-only draft warns and never crashes the stdout contract", async () => {
    const vaultRoot = await fixtureVault("wiki-v2");
    const dir = await tmpDir();
    const file = join(dir, "draft.md");
    await writeFile(file, "---\ntemplate: slice\nproject: wiki-v2\ntitle: Locked Draft\n---\n# Locked Draft\n");
    await chmod(file, 0o444); // read-only: the post-capture id stamp write will fault
    const { stdout, stderr, exitCode } = await runWiki(["hooks", "run"], {
      vaultRoot,
      stdin: JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { file_path: file } }),
    });
    await chmod(file, 0o644); // restore so afterEach cleanup can remove it
    // The hook must hold its contract: clean exit, stdout is still valid JSON ({}), the fault is on stderr.
    expect(exitCode).toBe(0);
    expect(stdout).toBe("{}");
    expect(stderr).toContain("authored but not captured");
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

    // the PostToolUse capture entry is wired with a write-tool matcher (the in-child capture trigger)
    expect(first.hooks.PostToolUse[0].matcher).toBe("^(?:Write|Edit|MultiEdit)$");
    expect(first.hooks.PostToolUse[0].hooks[0].command).toBe("wiki hooks run");

    // a UserPromptSubmit entry (debt-conditioned persist reminder) is written alongside the skill entry
    expect(first.hooks.UserPromptSubmit[0].hooks[0].command).toBe("wiki hooks run");
    // turn-end events are NOT wired (Stop fires mid-work by construction)
    expect(first.hooks.Stop).toBeUndefined();

    // re-run must not append a duplicate entry
    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });
    const second = JSON.parse(await readFile(settings, "utf8"));
    expect(second.hooks.PreToolUse).toHaveLength(1);
    expect(second.hooks.PostToolUse).toHaveLength(1);
    expect(second.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("the PostToolUse capture hook is installed and uninstalled per runtime (write-signal reaches the bridge)", async () => {
    for (const [runtime, file, matcher] of [
      ["claude-code", ".claude/settings.json", "^(?:Write|Edit|MultiEdit)$"],
      ["codex", ".codex/hooks.json", "^(?:write|edit)$"],
      ["pi", ".pi/agent/settings.json", "^(?:write|edit)$"],
    ] as const) {
      const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
      tempPaths.push(home);
      await runWiki(["hooks", "install", "--runtime", runtime, "--global"], { home });
      const config = JSON.parse(await readFile(join(home, file), "utf8"));
      // Without this entry the bridge never calls the hook on a write, so capture is dead in production.
      expect(config.hooks.PostToolUse[0].matcher).toBe(matcher);
      expect(config.hooks.PostToolUse[0].hooks[0].command).toBe("wiki hooks run");

      // uninstall must remove the capture entry too, leaving no wiki hook behind
      await runWiki(["hooks", "uninstall", "--runtime", runtime, "--global"], { home });
      const after = JSON.parse(await readFile(join(home, file), "utf8"));
      expect(JSON.stringify(after)).not.toContain("wiki hooks run");
    }
  });

  test("a UserPromptSubmit entry is written per runtime; no turn-end event is wired", async () => {
    for (const [runtime, file] of [
      ["claude-code", ".claude/settings.json"],
      ["codex", ".codex/hooks.json"],
      ["pi", ".pi/agent/settings.json"],
    ] as const) {
      const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
      tempPaths.push(home);
      await runWiki(["hooks", "install", "--runtime", runtime, "--global"], { home });
      const config = JSON.parse(await readFile(join(home, file), "utf8"));
      const wired = (config.hooks.UserPromptSubmit as { hooks?: { command?: string }[] }[]).some((e) =>
        e.hooks?.some((h) => h.command === "wiki hooks run"),
      );
      expect(wired, `${runtime} should wire UserPromptSubmit`).toBe(true);
      // Stop/SessionEnd fire at turn end — mid-work by construction — and must not be wired.
      expect(config.hooks.Stop, `${runtime} must not wire Stop`).toBeUndefined();
      expect(config.hooks.SessionEnd, `${runtime} must not wire SessionEnd`).toBeUndefined();
    }
  });
});

describe("wiki hooks install (merge semantics — never clobber foreign hooks)", () => {
  test("claude-code: foreign PreToolUse/Bash + SessionStart survive install, wiki events added, re-install idempotent", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const settings = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    // A live-shaped config: foreign rtk/herdr-style hooks on PreToolUse + a SessionStart.
    const foreignPre = { matcher: "Bash", hooks: [{ type: "command", command: "rtk guard" }] };
    const foreignSession = { hooks: [{ type: "command", command: "herdr session-start" }] };
    await writeFile(
      settings,
      JSON.stringify({ model: "opus", hooks: { PreToolUse: [foreignPre], SessionStart: [foreignSession] } }),
    );

    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });
    const after = JSON.parse(await readFile(settings, "utf8"));

    // Foreign entries survive byte-identical (deep-equal).
    expect(after.model).toBe("opus");
    expect(after.hooks.SessionStart).toEqual([foreignSession]);
    expect(after.hooks.PreToolUse).toContainEqual(foreignPre);
    // Wiki's three events are added (PreToolUse Skill alongside the foreign Bash entry).
    expect(after.hooks.PreToolUse.some((e: { matcher?: string }) => e.matcher === "Skill")).toBe(true);
    expect(after.hooks.PostToolUse[0].matcher).toBe("^(?:Write|Edit|MultiEdit)$");
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe("wiki hooks run");

    // Re-install is idempotent — no duplicate wiki entries, foreign untouched.
    await runWiki(["hooks", "install", "--runtime", "claude-code", "--global"], { home });
    const second = JSON.parse(await readFile(settings, "utf8"));
    expect(second.hooks.PreToolUse.filter((e: { matcher?: string }) => e.matcher === "Skill")).toHaveLength(1);
    expect(second.hooks.PreToolUse).toContainEqual(foreignPre);
    expect(second.hooks.PostToolUse).toHaveLength(1);
    expect(second.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("codex: foreign cmux hooks on 5 events survive; wiki adds UserPromptSubmit + capture; idempotent", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const file = join(home, ".codex", "hooks.json");
    await mkdir(join(home, ".codex"), { recursive: true });
    // cmux-style foreign hooks on 5 events.
    const cmux = (n: string) => ({ hooks: [{ type: "command", command: `cmux ${n}` }] });
    const foreign = {
      hooks: {
        UserPromptSubmit: [cmux("prompt")],
        PostToolUse: [cmux("post")],
        PreToolUse: [cmux("pre")],
        SessionStart: [cmux("start")],
        SessionEnd: [cmux("end")],
      },
    };
    await writeFile(file, JSON.stringify(foreign));

    await runWiki(["hooks", "install", "--runtime", "codex", "--global"], { home });
    const after = JSON.parse(await readFile(file, "utf8"));

    // Every foreign entry survives, on every event.
    for (const [event, entries] of Object.entries(foreign.hooks)) {
      expect(after.hooks[event]).toEqual(expect.arrayContaining(entries));
    }
    // Wiki adds its UserPromptSubmit (alongside foreign) and a PostToolUse capture — no turn-end event.
    expect(after.hooks.UserPromptSubmit.some((e: { hooks?: { command?: string }[] }) => e.hooks?.[0]?.command === "wiki hooks run")).toBe(true);
    expect(after.hooks.PostToolUse.some((e: { matcher?: string }) => e.matcher === "^(?:write|edit)$")).toBe(true);
    expect(JSON.stringify(after.hooks.Stop ?? [])).not.toContain("wiki hooks run");

    // Idempotent re-install.
    await runWiki(["hooks", "install", "--runtime", "codex", "--global"], { home });
    const second = JSON.parse(await readFile(file, "utf8"));
    expect(second.hooks.UserPromptSubmit.filter((e: { hooks?: { command?: string }[] }) => e.hooks?.[0]?.command === "wiki hooks run")).toHaveLength(1);
  });

  test("pi: merge preserves foreign settings and is idempotent", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const file = join(home, ".pi", "agent", "settings.json");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(file, JSON.stringify({ packages: [{ source: "npm:@hsingjui/pi-hooks" }], hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "foreign" }] }] } }));

    await runWiki(["hooks", "install", "--runtime", "pi", "--global"], { home });
    const after = JSON.parse(await readFile(file, "utf8"));
    // foreign package + hook survive
    expect(after.packages).toEqual([{ source: "npm:@hsingjui/pi-hooks" }]);
    expect(after.hooks.UserPromptSubmit.some((e: { hooks?: { command?: string }[] }) => e.hooks?.[0]?.command === "foreign")).toBe(true);
    expect(after.hooks.UserPromptSubmit.some((e: { hooks?: { command?: string }[] }) => e.hooks?.[0]?.command === "wiki hooks run")).toBe(true);

    await runWiki(["hooks", "install", "--runtime", "pi", "--global"], { home });
    const second = JSON.parse(await readFile(file, "utf8"));
    expect(second.hooks.UserPromptSubmit.filter((e: { hooks?: { command?: string }[] }) => e.hooks?.[0]?.command === "wiki hooks run")).toHaveLength(1);
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

  test("uninstall sweeps wiki entries on events the current spec no longer wires (legacy Stop/SessionEnd)", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const settings = join(home, ".claude", "settings.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".claude"), { recursive: true });
    // A config written by an older binary: wiki entries on Stop + SessionEnd, plus a foreign Stop sibling.
    await writeFile(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "cmux stop" }] },
            { hooks: [{ type: "command", command: "wiki hooks run" }] },
          ],
          SessionEnd: [{ hooks: [{ type: "command", command: "wiki hooks run" }] }],
        },
      }),
    );
    await runWiki(["hooks", "uninstall", "--runtime", "claude-code", "--global"], { home });
    const after = JSON.parse(await readFile(settings, "utf8"));
    expect(JSON.stringify(after)).not.toContain("wiki hooks run");
    // the foreign Stop sibling survives; the wiki-only SessionEnd key is dropped entirely
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe("cmux stop");
    expect(after.hooks.SessionEnd).toBeUndefined();
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

  test("a runtime wired with only SOME required events reports as partial, naming the missing ones", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const settings = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    // Only the PreToolUse (Skill) wiki hook is wired — PostToolUse + UserPromptSubmit are missing.
    await writeFile(
      settings,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "wiki hooks run" }] }] } }),
    );
    const status = await runWiki(["hooks", "status"], { home });
    expect(status.exitCode).toBe(0);
    const line = status.stdout.split("\n").find((l) => l.startsWith("claude-code global:"))!;
    expect(line).toContain("partial");
    expect(line).toContain("MISSING");
    expect(line).toContain("PostToolUse");
    expect(line).toContain("UserPromptSubmit");
    // partial must NOT read as a clean "wired (...)" state
    expect(line).not.toMatch(/wired \(PreToolUse, PostToolUse, UserPromptSubmit\)/);
  });

  test("an agent with `extensions: all` reaches the bridge (all includes it), and frontmatterless files are skipped", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const agentsDir = join(home, ".pi", "agent", "agents");
    await mkdir(agentsDir, { recursive: true });
    // `extensions: all` is the no-restriction sentinel → reachable, not a false positive.
    await writeFile(join(agentsDir, "architect.md"), "---\nname: architect\nextensions: all\n---\nbody\n");
    // A template doc with no frontmatter is not an agent → skipped entirely.
    await writeFile(join(agentsDir, "scout-report-template.md"), "# Scout report template\n\njust a doc\n");

    const status = await runWiki(["hooks", "status"], { home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("subagent architect: reachable");
    expect(status.stdout).not.toContain("scout-report-template");
    expect(status.stdout).not.toMatch(/subagent architect: cannot fire/);
  });

  test("reports per-subagent bridge reachability, naming the agents whose allowlist lacks the exact bridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "wiki-home-"));
    tempPaths.push(home);
    const agentsDir = join(home, ".pi", "agent", "agents");
    await mkdir(agentsDir, { recursive: true });
    // exact scoped bridge present → reachable
    await writeFile(
      join(agentsDir, "alpha.md"),
      "---\nname: alpha\nextensions: git:github.com/edxeth/pi-better-skills, npm:@hsingjui/pi-hooks\n---\nbody\n",
    );
    // no bridge at all → cannot fire
    await writeFile(
      join(agentsDir, "beta.md"),
      "---\nname: beta\nextensions: git:github.com/edxeth/pi-better-skills\n---\nbody\n",
    );
    // an unscoped / forked lookalike does NOT satisfy the check → cannot fire
    await writeFile(
      join(agentsDir, "gamma.md"),
      "---\nname: gamma\nextensions: git:github.com/prateekmedia/pi-hooks\n---\nbody\n",
    );

    const status = await runWiki(["hooks", "status"], { home });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("subagent alpha: reachable");
    expect(status.stdout).toMatch(/subagent beta: cannot fire/);
    expect(status.stdout).toMatch(/subagent gamma: cannot fire/);
    // the parent/global wired state is still reported truthfully alongside the subagent tier
    expect(status.stdout).toContain("pi global:");
  });
});
