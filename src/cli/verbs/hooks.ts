import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { SKILL_TO_KIND } from "../../artifacts/registry";
import { readLinkedProject } from "../repo-link";
import { unknownMessage } from "../usage";
import { booleanValue, parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

/** The command the installed native hooks invoke (assumes `wiki` is on PATH). */
const HOOK_COMMAND = "wiki hooks run";

/**
 * Per-runtime install target. All three runtimes accept the same JSON `hooks`
 * schema and the same stdin/stdout contract; only the file and the event/matcher
 * differ, because each surfaces a skill invocation through a different signal:
 *  - Claude Code: a dedicated `Skill` tool      → PreToolUse, matcher "Skill"
 *  - Codex / pi:  no skill tool — a slash-command in the prompt → UserPromptSubmit
 */
const RUNTIMES: Record<string, { event: string; matcher?: string; global: string; project: string }> = {
  "claude-code": { event: "PreToolUse", matcher: "Skill", global: ".claude/settings.json", project: ".claude/settings.json" },
  codex: { event: "UserPromptSubmit", global: ".codex/hooks.json", project: ".codex/hooks.json" },
  pi: { event: "UserPromptSubmit", global: ".pi/agent/settings.json", project: ".pi/settings.json" },
};

export async function handleHooks(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "run") return hooksRun();
  if (subverb === "install") return hooksInstall(rest);
  console.error(unknownMessage("hooks subverb", subverb ?? "", ["run", "install"]));
  return { code: 1 };
}

/** The fields any of the three runtimes may put on a hook's stdin payload. */
interface HookInput {
  cwd?: string;
  hook_event_name?: string;
  tool_input?: { skill_name?: string; path?: string };
  prompt?: string;
}

/**
 * The skill being invoked, drawn from whichever signal the runtime provides:
 * Claude Code's `skill_name`, a pi `read` of a `SKILL.md` (→ its folder name),
 * or a `/skill:<name>` slash-command in the prompt (Codex, pi). Null when none
 * names a registered authoring skill, so the caller injects nothing.
 */
function extractSkill(input: HookInput): string | null {
  const named = input.tool_input?.skill_name;
  if (named !== undefined && named in SKILL_TO_KIND) return named;

  const path = input.tool_input?.path;
  if (path !== undefined && basename(path) === "SKILL.md") {
    const skill = basename(dirname(path));
    if (skill in SKILL_TO_KIND) return skill;
  }

  const prompt = input.prompt;
  if (prompt !== undefined) {
    // skill names are kebab-case; match a /skill:name or /name token, not a bare mention
    for (const skill of Object.keys(SKILL_TO_KIND)) {
      if (new RegExp(`(?:^|\\s)/(?:skill:)?${skill}(?![\\w-])`).test(prompt)) return skill;
    }
  }
  return null;
}

/** Runtime callback: read the hook payload on stdin, emit guidance (or `{}`). */
async function hooksRun(): Promise<CliResult> {
  let input: HookInput = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    // no/invalid payload — nothing to act on
  }
  const skill = extractSkill(input);
  const guidance = skill === null ? null : await hookGuidance(skill, input.cwd ?? process.cwd());
  if (guidance === null) {
    process.stdout.write("{}");
    return { code: 0 };
  }
  const event = input.hook_event_name ?? "PreToolUse";
  const hookSpecificOutput: Record<string, string> = { hookEventName: event, additionalContext: guidance };
  if (event === "PreToolUse") hookSpecificOutput.permissionDecision = "allow";
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  return { code: 0 };
}

/**
 * Guidance to inject when a registered authoring skill is invoked: remind the
 * agent to persist the skill's output to the vault via `wiki create`. Returns
 * null when the skill authors no kind (per wiki.json) — the caller injects nothing.
 */
export async function hookGuidance(skill: string, cwd: string): Promise<string | null> {
  const kind = SKILL_TO_KIND[skill];
  if (kind === undefined) return null;
  const project = await readLinkedProject(cwd);
  const projectFlag = project === null ? "--project <name>" : `--project ${project}`;
  return (
    `The ${skill} skill authors a wiki '${kind}' artifact. When it finishes, persist the ` +
    `result to the vault — don't leave it only in chat:\n  wiki create ${kind} ${projectFlag} --body -`
  );
}

/** Merge the hook entry into a runtime's native config file (create/merge, never clobber). */
async function hooksInstall(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["runtime"], [], ["global"]);
  const runtime = stringValue(parsed.values, "runtime");
  if (runtime === undefined || !(runtime in RUNTIMES)) {
    console.error(`missing or unknown --runtime; expected one of: ${Object.keys(RUNTIMES).join(", ")}`);
    return { code: 1 };
  }
  const spec = RUNTIMES[runtime]!;
  const file = booleanValue(parsed.values, "global")
    ? join(homedir(), spec.global)
    : join(process.cwd(), spec.project);

  // Read-merge-write so existing hooks/settings survive (data-loss boundary).
  let config: { hooks?: Record<string, unknown[]> } = {};
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // absent or empty — start fresh
  }
  config.hooks ??= {};
  const list = (config.hooks[spec.event] ??= []) as { matcher?: string; hooks?: { type?: string; command?: string }[] }[];

  if (list.some((entry) => entry.hooks?.some((h) => h.command === HOOK_COMMAND))) {
    console.error(`already installed: ${spec.event} hook in ${file}`);
    return { code: 0 };
  }

  list.push({
    ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  console.log(file);
  if (runtime === "pi") console.error("pi needs the hooks package: pi install npm:@hsingjui/pi-hooks");
  return { code: 0 };
}
