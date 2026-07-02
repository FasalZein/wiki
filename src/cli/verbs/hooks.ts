import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { readFrontmatter } from "../../artifacts/artifact-file";
import { captureArtifact, type CaptureOutcome } from "../../artifacts/capture";
import { DEFAULT_STRUCTURE, loadStructure, type Structure } from "../../artifacts/registry";
import { resolveVaultRootForDisplay } from "../../config/vault";
import { readLinkedProject } from "../repo-link";
import { unknownMessage } from "../usage";
import { booleanValue, parseCommand, stringValue } from "../parse";
import { emitJson, jsonEnabled } from "../output";
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
  "persist it to the vault now — don't leave it only in chat. Either run\n  wiki create <kind> --project <name> --body -\n" +
  "or stamp the draft's frontmatter with `template: <kind>` and `project: <name>` so the write hook captures it on save.";

/**
 * Per-runtime install target. All three runtimes accept the same JSON `hooks`
 * schema and the same stdin/stdout contract; only the file and the events
 * differ. Each runtime wires the same three event roles, surfaced through
 * whatever signal that runtime provides:
 *  - skill invocation: Claude Code's dedicated `Skill` tool (PreToolUse, matcher
 *    "Skill"); Codex / pi have no skill tool, so a slash-command in the prompt
 *    (UserPromptSubmit).
 *  - artifact write: a file-write tool (PostToolUse, matched to the runtime's
 *    write/edit tool names) — the in-child capture trigger (ADR-0038).
 *  - session end: a stateless blanket persist reminder (Stop / SessionEnd). It
 *    has no session state, so it reminds unconditionally.
 */
interface HookTarget {
  event: string;
  /** Tool-name regex the runtime tests against; absent means "every event". */
  matcher?: string;
}

interface RuntimeSpec {
  events: HookTarget[];
  global: string;
  project: string;
}

/** Write-tool name matchers, anchored so they don't match e.g. `rewrite`. */
const CLAUDE_WRITE = "^(?:Write|Edit|MultiEdit)$";
const POSIX_WRITE = "^(?:write|edit)$";

const RUNTIMES: Record<string, RuntimeSpec> = {
  "claude-code": {
    events: [{ event: "PreToolUse", matcher: "Skill" }, { event: "PostToolUse", matcher: CLAUDE_WRITE }, { event: "Stop" }],
    global: ".claude/settings.json",
    project: ".claude/settings.json",
  },
  codex: {
    events: [{ event: "UserPromptSubmit" }, { event: "PostToolUse", matcher: POSIX_WRITE }, { event: "Stop" }],
    global: ".codex/hooks.json",
    project: ".codex/hooks.json",
  },
  pi: {
    events: [{ event: "UserPromptSubmit" }, { event: "PostToolUse", matcher: POSIX_WRITE }, { event: "SessionEnd" }],
    global: ".pi/agent/settings.json",
    project: ".pi/settings.json",
  },
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

/** The fields any of the three runtimes may put on a hook's stdin payload.
 *  `tool_input` is the invoked tool's OWN parameter object verbatim: the Skill tool
 *  declares `skill` (the name) + `args`, so that — not `skill_name` — is the real
 *  key; we read both defensively. Write/Edit declare `file_path`/`content`. The
 *  PostToolUse output key is `tool_response` in the hooks doc but `tool_result` in
 *  the anthropics hook-development SKILL.md — carried here (both) so a handler that
 *  needs the tool output reads whichever the runtime sends; capture re-reads the
 *  file from disk, so it does not consume either. */
interface HookInput {
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_input?: { skill?: string; skill_name?: string; path?: string; file_path?: string; content?: string };
  tool_response?: unknown;
  tool_result?: unknown;
  prompt?: string;
}

/** Events that follow a tool call — the run callback inspects artifact writes for these. */
const WRITE_EVENT = "PostToolUse";

/**
 * The skill being invoked, drawn from whichever signal the runtime provides:
 * Claude Code's `skill_name`, a pi `read` of a `SKILL.md` (→ its folder name),
 * or a `/skill:<name>` slash-command in the prompt (Codex, pi). Null when none
 * names a registered authoring skill, so the caller injects nothing.
 */
/** Kinds are data: the vault's wiki.json is authoritative for skill→kind routing,
 *  so a vault that declares its own kinds (or extra skill bindings) routes without
 *  any code change. Hooks fire in arbitrary cwds, so resolution is best-effort —
 *  no configured vault, or a malformed wiki.json, falls back to the bundled
 *  default rather than failing the hook. */
async function hookStructure(): Promise<Structure> {
  const root = await resolveVaultRootForDisplay();
  if (root === null) return DEFAULT_STRUCTURE;
  try {
    return await loadStructure(root);
  } catch {
    return DEFAULT_STRUCTURE;
  }
}

/** Authoring skills the structure's kinds register, for prompt scanning. */
function registeredSkills(structure: Structure): string[] {
  return Object.values(structure.kinds)
    .map((spec) => spec.skill)
    .filter((skill): skill is string => skill !== undefined);
}

function extractSkill(input: HookInput, structure: Structure): string | null {
  // Claude Code's Skill tool carries the name as `tool_input.skill`; older/other
  // shapes used `skill_name`. Accept either so the reminder fires regardless.
  const named = input.tool_input?.skill ?? input.tool_input?.skill_name;
  if (named !== undefined && structure.kindForSkill(named) !== undefined) return named;

  const path = input.tool_input?.path;
  if (path !== undefined && basename(path) === "SKILL.md") {
    const skill = basename(dirname(path));
    if (structure.kindForSkill(skill) !== undefined) return skill;
  }

  const prompt = input.prompt;
  if (prompt !== undefined) {
    // skill names are kebab-case; match a /skill:name or /name token, not a bare mention
    for (const skill of registeredSkills(structure)) {
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
  if (event === WRITE_EVENT) {
    const path = input.tool_input?.file_path ?? input.tool_input?.path;
    const capture = path === undefined ? null : await captureArtifact({ path, cwd: input.cwd ?? process.cwd() });
    if (capture === null) {
      process.stdout.write("{}");
      return { code: 0 };
    }
    if (capture.outcome === "warn") {
      console.error(capture.warning); // surfaced, never a silent drop
      process.stdout.write("{}");
      return { code: 0 };
    }
    if (capture.note !== undefined) console.error(capture.note); // SLICE-0127: advisory dedup note, filed anyway
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: capture.context } }));
    return { code: 0 };
  }
  const guidance = STOP_EVENTS.has(event)
    ? await stopReminderOnce(input)
    : await (async () => {
        const structure = await hookStructure();
        const skill = extractSkill(input, structure);
        return skill === null ? null : hookGuidance(skill, input.cwd ?? process.cwd(), structure);
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

/** The Stop reminder fires ONCE per session: harnesses re-invoke the agent on
 *  every additionalContext injection, so an unconditional reminder loops the
 *  stop forever (observed live on claude-code 2026-07-02). Deduped by a tmpdir
 *  marker keyed on session_id; payloads without one fall back to cwd+day. */
async function stopReminderOnce(input: HookInput): Promise<string | null> {
  const { tmpdir } = await import("node:os");
  const key = (input.session_id ?? `${input.cwd ?? "nocwd"}-${new Date().toISOString().slice(0, 10)}`).replace(/[^\w.-]/g, "_");
  const marker = `${tmpdir()}/wiki-stop-reminder-${key}`;
  if (await Bun.file(marker).exists()) return null;
  await Bun.write(marker, new Date().toISOString());
  return STOP_REMINDER;
}

/**
 * Guidance to inject when a registered authoring skill is invoked: remind the
 * agent to persist the skill's output to the vault via `wiki create`. Returns
 * null when the skill authors no kind (per wiki.json) — the caller injects nothing.
 */
export async function hookGuidance(skill: string, cwd: string, structure: Structure = DEFAULT_STRUCTURE): Promise<string | null> {
  const kind = structure.kindForSkill(skill);
  if (kind === undefined) return null;
  const project = await readLinkedProject(cwd);
  const projectFlag = project === null ? "--project <name>" : `--project ${project}`;
  const projectStamp = project === null ? "<name>" : project;
  return (
    `The ${skill} skill authors a wiki '${kind}' artifact. When it finishes, persist the ` +
    `result to the vault — don't leave it only in chat:\n  wiki create ${kind} ${projectFlag} --body -\n` +
    `or stamp the draft's frontmatter with \`template: ${kind}\` and \`project: ${projectStamp}\` so the write hook captures it on save.`
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

/** Merge this runtime's hook entries into its native config (create/merge, never clobber). */
async function hooksInstall(args: string[]): Promise<CliResult> {
  const target = resolveTarget(args);
  if (!("spec" in target)) return target;
  const { spec, runtime, file } = target;

  // Read-merge-write so existing hooks/settings survive (data-loss boundary).
  const config = await readConfig(file);
  config.hooks ??= {};

  let added = false;
  for (const t of spec.events) {
    const list = (config.hooks[t.event] ??= []);
    if (isWired(list)) continue;
    list.push({
      ...(t.matcher === undefined ? {} : { matcher: t.matcher }),
      hooks: [{ type: "command", command: HOOK_COMMAND }],
    });
    added = true;
  }

  if (!added) {
    if (jsonEnabled()) emitJson({ runtime, file, installed: false, alreadyInstalled: true });
    else console.error(`already installed: ${spec.events.map((t) => t.event).join("/")} hooks in ${file}`);
    return { code: 0 };
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  if (jsonEnabled()) emitJson({ runtime, file, installed: true, events: spec.events.map((t) => t.event) });
  else console.log(file);
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
 * True when a package spec names the EXACT scoped bridge `@hsingjui/pi-hooks`.
 * The `npm:`/`git:` prefix is stripped, then the id must equal the scoped name
 * or end in `/@hsingjui/pi-hooks` (a registry path). An unscoped `pi-hooks` or a
 * forked `pi-hooks` is a lookalike — same name, different contract — and is
 * rejected. The single rule reused by the install warning, status, and doctor.
 */
function isPiBridge(spec: string): boolean {
  const id = spec.replace(/^(?:npm:|git:)/, "");
  return id === PI_BRIDGE_PACKAGE || id.endsWith(`/${PI_BRIDGE_PACKAGE}`);
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
  const enabled = packages.some((entry) => isPiBridge(packageSource(entry)));
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
    if (jsonEnabled()) emitJson({ file, uninstalled: false, removed: 0 });
    else console.error(`nothing to uninstall in ${file}`);
    return { code: 0 };
  }

  let removed = 0;
  for (const { event } of spec.events) {
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
    if (jsonEnabled()) emitJson({ file, uninstalled: false, removed: 0 });
    else console.error(`no wiki hook found in ${file}`);
    return { code: 0 };
  }
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  if (jsonEnabled()) emitJson({ file, uninstalled: true, removed });
  else console.log(file);
  return { code: 0 };
}

/**
 * Per-subagent bridge reachability. Each pi subagent definition
 * (`~/.pi/agent/agents/<name>.md`) declares its enabled extensions in an
 * `extensions:` frontmatter field, which is a RESTRICTIVE allowlist: a subagent
 * loads only the extensions it lists (every shipped agent re-lists its full set,
 * which only makes sense if listing is required), so its persist hook can fire
 * only when that allowlist carries the EXACT `@hsingjui/pi-hooks` bridge — or the
 * `all` sentinel, which loads every extension (bridge included). We inspect those
 * files (read-only — never edited here) and report, per agent, whether the bridge
 * is reachable. A lookalike does not satisfy it (reuses `isPiBridge`). A `.md` with
 * no frontmatter is a template/doc, not an agent, and is skipped; an agent
 * explicitly `enabled: false` is skipped too — it never runs, so it is not a gap.
 */
type AgentReach = { name: string; reachable: boolean };

/** The extensions an agent declares, from a comma-separated string or a list. */
function agentExtensions(data: Record<string, unknown>): string[] {
  const ext = data.extensions;
  if (typeof ext === "string") return ext.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (Array.isArray(ext)) return ext.map((e) => String(e).trim()).filter((s) => s.length > 0);
  return [];
}

/** True when a subagent's allowlist reaches the bridge: the exact scoped package is
 *  listed, OR the allowlist is the `all` sentinel (which loads every extension,
 *  bridge included). `all` is NOT a lookalike — it is the "no restriction" marker. */
function reachesBridge(data: Record<string, unknown>): boolean {
  const ext = agentExtensions(data);
  return ext.includes("all") || ext.some(isPiBridge);
}

/** Inspect each enabled subagent definition's allowlist for the exact bridge (read-only). */
async function agentReachability(home: string): Promise<AgentReach[]> {
  const dir = join(home, ".pi", "agent", "agents");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return []; // no agents directory — no subagent tier to report
  }
  const out: AgentReach[] = [];
  for (const file of names) {
    let data: Record<string, unknown>;
    try {
      data = readFrontmatter(await readFile(join(dir, file), "utf8")).data;
    } catch {
      continue; // unparseable agent file — skip
    }
    // A .md with no frontmatter is a doc/template dropped in the agents dir, not an
    // agent definition (e.g. scout-report-template.md) — never a reachability gap.
    if (Object.keys(data).length === 0) continue;
    if (data.enabled === false) continue; // disabled agent never runs — not a reachability gap
    const name = typeof data.name === "string" ? data.name : basename(file, ".md");
    out.push({ name, reachable: reachesBridge(data) });
  }
  return out;
}

/** Subagents whose allowlist cannot reach the bridge — read by `doctor --setup`. */
export async function unreachableSubagents(home: string = homedir()): Promise<string[]> {
  return (await agentReachability(home)).filter((a) => !a.reachable).map((a) => a.name);
}

/** Report which runtimes/scopes have the wiki hook wired (shared by `list` and `status`). */
async function hooksReport(): Promise<CliResult> {
  const json = jsonEnabled();
  const runtimes: {
    runtime: string;
    scope: string;
    wired: boolean;
    partial: boolean;
    events: string[];
    missing: string[];
    file: string;
  }[] = [];
  for (const [runtime, spec] of Object.entries(RUNTIMES)) {
    for (const [scope, rel] of [
      ["global", spec.global],
      ["project", spec.project],
    ] as const) {
      const file = scope === "global" ? join(homedir(), rel) : join(process.cwd(), rel);
      const config = await readConfig(file);
      const required = spec.events.map((t) => t.event);
      const events = required.filter((e) => isWired(config.hooks?.[e]));
      const missing = required.filter((e) => !events.includes(e));
      // Honest tri-state: a hook is only "wired" when ALL its required events are
      // present; some-but-not-all is "partial" (broken — the roles it needs to cover
      // don't all fire), never "wired". Naming the missing events is the fix signal.
      const partial = events.length > 0 && missing.length > 0;
      const wired = events.length > 0 && missing.length === 0;
      runtimes.push({ runtime, scope, wired, partial, events, missing, file });
      if (!json) {
        const state = wired
          ? `wired (${events.join(", ")})`
          : partial
            ? `partial — wired ${events.join(", ")}; MISSING ${missing.join(", ")}`
            : "not wired";
        console.log(`${runtime} ${scope}: ${state}  ${file}`);
      }
    }
  }
  // Per-subagent reachability: a subagent's hook fires only if its allowlist
  // carries the exact bridge. Naming the ones that can't fire is the honest
  // signal a single global "wired" hides.
  const subagents = await agentReachability(homedir());
  if (!json) {
    for (const agent of subagents) {
      const state = agent.reachable
        ? `reachable (${PI_BRIDGE_PACKAGE} in allowlist)`
        : `cannot fire (${PI_BRIDGE_PACKAGE} missing from allowlist)`;
      console.log(`subagent ${agent.name}: ${state}`);
    }
  }
  if (json) emitJson({ runtimes, subagents });
  return { code: 0 };
}

/** True when the wiki hook is wired in any runtime/scope — read by `doctor --setup`. */
export async function anyHookWired(cwd: string = process.cwd()): Promise<boolean> {
  for (const spec of Object.values(RUNTIMES)) {
    for (const file of [join(homedir(), spec.global), join(cwd, spec.project)]) {
      const config = await readConfig(file);
      if (spec.events.some((t) => isWired(config.hooks?.[t.event]))) return true;
    }
  }
  return false;
}

/**
 * Runtime/scope labels wired with SOME but not all required events — read by
 * `doctor --setup`. A partially-wired runtime is broken (a role it needs to cover
 * won't fire), so it is reported distinctly from a fully-unwired one, with the
 * missing events named. `anyHookWired` stays true for these (something IS wired),
 * so this is the signal that turns "hook present" into "hook complete".
 */
export async function partiallyWiredRuntimes(cwd: string = process.cwd()): Promise<string[]> {
  const out: string[] = [];
  for (const [runtime, spec] of Object.entries(RUNTIMES)) {
    for (const [scope, file] of [
      ["global", join(homedir(), spec.global)],
      ["project", join(cwd, spec.project)],
    ] as const) {
      const config = await readConfig(file);
      const required = spec.events.map((t) => t.event);
      const wired = required.filter((e) => isWired(config.hooks?.[e]));
      if (wired.length > 0 && wired.length < required.length) {
        out.push(`${runtime} ${scope} (missing: ${required.filter((e) => !wired.includes(e)).join(", ")})`);
      }
    }
  }
  return out;
}
