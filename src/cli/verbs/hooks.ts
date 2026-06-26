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

/** The pi extension package that forwards hook events to this CLI (exact scoped name; forks are lookalikes). */
const PI_BRIDGE_PACKAGE = "@hsingjui/pi-hooks";

/**
 * Stateless session-end reminder. Fired on Stop/SessionEnd with no session state,
 * so it cannot know whether anything was authored or persisted — it reminds
 * unconditionally and the agent ignores it when there's nothing to save.
 */
const STOP_REMINDER =
  "Session ending. If you authored a PRD, slice, decision, doc, or handoff this session, " +
  "persist it to the vault now — don't leave it only in chat:\n  wiki create <kind> --project <name> --body -";

/**
 * Per-runtime install target. All three runtimes accept the same JSON `hooks`
 * schema and the same stdin/stdout contract; only the file and the events differ,
 * because each surfaces a skill invocation through a different signal:
 *  - Claude Code: a dedicated `Skill` tool      → PreToolUse, matcher "Skill"
 *  - Codex / pi:  no skill tool — a slash-command in the prompt → UserPromptSubmit
 *
 * `stop` is a second, stateless entry fired at session end: a blanket reminder to
 * persist any authored artifact. It cannot detect whether persistence happened —
 * it has no session state — so it reminds unconditionally.
 */
interface RuntimeSpec {
  event: string;
  matcher?: string;
  stop: string;
  global: string;
  project: string;
}

const RUNTIMES: Record<string, RuntimeSpec> = {
  "claude-code": { event: "PreToolUse", matcher: "Skill", stop: "Stop", global: ".claude/settings.json", project: ".claude/settings.json" },
  codex: { event: "UserPromptSubmit", stop: "SessionEnd", global: ".codex/hooks.json", project: ".codex/hooks.json" },
  pi: { event: "UserPromptSubmit", stop: "SessionEnd", global: ".pi/agent/settings.json", project: ".pi/settings.json" },
};

/** Events that fire at session end — the run callback emits a blanket persist reminder for these. */
const STOP_EVENTS = new Set(["Stop", "SessionEnd"]);

export async function handleHooks(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "run") return hooksRun();
  if (subverb === "install") return hooksInstall(rest);
  if (subverb === "uninstall") return hooksUninstall(rest);
  if (subverb === "list" || subverb === "status") return hooksReport();
  console.error(unknownMessage("hooks subverb", subverb ?? "", ["run", "install", "uninstall", "list", "status"]));
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
  const event = input.hook_event_name ?? "PreToolUse";
  const guidance = STOP_EVENTS.has(event)
    ? STOP_REMINDER
    : await (async () => {
        const skill = extractSkill(input);
        return skill === null ? null : hookGuidance(skill, input.cwd ?? process.cwd());
      })();
  if (guidance === null) {
    process.stdout.write("{}");
    return { code: 0 };
  }
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

/** A hook entry as it lives in any runtime's native `hooks` config. */
type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] };

/** Resolve --runtime + --global into a concrete spec and config path, or an error result. */
function resolveTarget(args: string[]): { spec: RuntimeSpec; runtime: string; file: string } | { code: number } {
  const parsed = parseCommand(args, ["runtime"], [], ["global"]);
  const runtime = stringValue(parsed.values, "runtime");
  if (runtime === undefined || !(runtime in RUNTIMES)) {
    console.error(`missing or unknown --runtime; expected one of: ${Object.keys(RUNTIMES).join(", ")}`);
    return { code: 1 };
  }
  const spec = RUNTIMES[runtime]!;
  const file = booleanValue(parsed.values, "global") ? join(homedir(), spec.global) : join(process.cwd(), spec.project);
  return { spec, runtime, file };
}

async function readConfig(file: string): Promise<{ hooks?: Record<string, HookEntry[]> } & Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {}; // absent or empty — start fresh
  }
}

/** True when an event's list already wires HOOK_COMMAND. */
function isWired(list: HookEntry[] | undefined): boolean {
  return list?.some((entry) => entry.hooks?.some((h) => h.command === HOOK_COMMAND)) ?? false;
}

/** Merge the skill + stop hook entries into a runtime's native config (create/merge, never clobber). */
async function hooksInstall(args: string[]): Promise<CliResult> {
  const target = resolveTarget(args);
  if (!("spec" in target)) return target;
  const { spec, runtime, file } = target;

  // Read-merge-write so existing hooks/settings survive (data-loss boundary).
  const config = await readConfig(file);
  config.hooks ??= {};

  // Two entries: the skill-invocation hook and the stateless session-end reminder.
  const targets: { event: string; matcher?: string }[] = [
    { event: spec.event, matcher: spec.matcher },
    { event: spec.stop },
  ];
  let added = false;
  for (const t of targets) {
    const list = (config.hooks[t.event] ??= []);
    if (isWired(list)) continue;
    list.push({
      ...(t.matcher === undefined ? {} : { matcher: t.matcher }),
      hooks: [{ type: "command", command: HOOK_COMMAND }],
    });
    added = true;
  }

  if (!added) {
    console.error(`already installed: ${spec.event}/${spec.stop} hooks in ${file}`);
    return { code: 0 };
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  console.log(file);
  if (runtime === "pi") await warnPiBridge();
  return { code: 0 };
}

/** A pi `packages[]` entry: a bare git/npm id string, or an object with a `source`. */
function packageSource(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string") {
    return (entry as { source: string }).source;
  }
  return "";
}

/**
 * pi can't see skill invocations on its own — it needs the @hsingjui/pi-hooks
 * bridge enabled in its global packages[] to forward hook events. If that exact
 * scoped package is absent, warn loudly and disambiguate it from the lookalikes,
 * so the install doesn't silently no-op.
 */
async function warnPiBridge(): Promise<void> {
  const settings = await readConfig(join(homedir(), RUNTIMES.pi!.global));
  const packages = Array.isArray((settings as { packages?: unknown }).packages)
    ? ((settings as { packages: unknown[] }).packages)
    : [];
  const enabled = packages.some((entry) => {
    const id = packageSource(entry).replace(/^(?:npm:|git:)/, "");
    return id === PI_BRIDGE_PACKAGE || id.endsWith(`/${PI_BRIDGE_PACKAGE}`);
  });
  if (enabled) return;
  console.error(
    `pi bridge missing: enable ${PI_BRIDGE_PACKAGE} in pi's packages[] (pi install npm:${PI_BRIDGE_PACKAGE}) — ` +
      `without it pi never forwards hook events and this hook never fires.\n` +
      `  Use the exact scoped package: ${PI_BRIDGE_PACKAGE}. Unscoped 'pi-hooks' and '*/pi-hooks' forks ` +
      `are lookalikes — same name, different contract — and will NOT wire the wiki reminder.`,
  );
}

/** Splice out only the entries this CLI installed (command === HOOK_COMMAND), leaving everything else intact. */
async function hooksUninstall(args: string[]): Promise<CliResult> {
  const target = resolveTarget(args);
  if (!("spec" in target)) return target;
  const { spec, file } = target;

  const config = await readConfig(file);
  if (config.hooks === undefined) {
    console.error(`nothing to uninstall in ${file}`);
    return { code: 0 };
  }

  let removed = 0;
  for (const event of [spec.event, spec.stop]) {
    const list = config.hooks[event];
    if (list === undefined) continue;
    for (const entry of list) {
      const before = entry.hooks?.length ?? 0;
      if (entry.hooks) entry.hooks = entry.hooks.filter((h) => h.command !== HOOK_COMMAND);
      removed += before - (entry.hooks?.length ?? 0);
    }
    // drop entries left with no hooks (so a wiki-only entry vanishes; a shared one keeps its siblings)
    config.hooks[event] = list.filter((entry) => (entry.hooks?.length ?? 0) > 0);
    if (config.hooks[event]!.length === 0) delete config.hooks[event];
  }

  if (removed === 0) {
    console.error(`no wiki hook found in ${file}`);
    return { code: 0 };
  }
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  console.log(file);
  return { code: 0 };
}

/** Report which runtimes/scopes have the wiki hook wired (shared by `list` and `status`). */
async function hooksReport(): Promise<CliResult> {
  for (const [runtime, spec] of Object.entries(RUNTIMES)) {
    for (const [scope, rel] of [
      ["global", spec.global],
      ["project", spec.project],
    ] as const) {
      const file = scope === "global" ? join(homedir(), rel) : join(process.cwd(), rel);
      const config = await readConfig(file);
      const events = [spec.event, spec.stop].filter((e) => isWired(config.hooks?.[e]));
      const state = events.length > 0 ? `wired (${events.join(", ")})` : "not wired";
      console.log(`${runtime} ${scope}: ${state}  ${file}`);
    }
  }
  return { code: 0 };
}
