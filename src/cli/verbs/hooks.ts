import matter from "gray-matter";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { DEFAULT_STRUCTURE, loadStructure } from "../../artifacts/registry";
import { artifactDirectory } from "../../artifacts/paths";
import { nextId } from "../../artifacts/id";
import { buildIdIndex } from "../../artifacts/id-index";
import { slugifyTitle } from "../../artifacts/store";
import { getVaultRoot } from "../../config/vault";
import type { TemplateType } from "../../schema/load";
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
  tool_input?: { skill_name?: string; path?: string; file_path?: string };
  prompt?: string;
}

/** Events that follow a tool call — the run callback inspects artifact writes for these. */
const WRITE_EVENT = "PostToolUse";

/**
 * Inspecting a PostToolUse write yields one of three outcomes: `captured` (the
 * written file is an authoring artifact and the hook filed it into the vault
 * itself — `context` is injected so the model need not run `wiki create`),
 * `warn` (it looks like an artifact but cannot be captured — surfaced on stderr,
 * never a silent drop and never a wrong-kind write), or null (an unrelated write).
 */
type CaptureOutcome =
  | { outcome: "captured"; context: string }
  | { outcome: "warn"; warning: string }
  | null;

/**
 * The kind a written file declares in its OWN frontmatter, resolved via the
 * registry (ADR-0038): a `template:` field naming a kind, or an `id:` whose
 * prefix resolves to one (e.g. PRD-0099 → prd). Null when nothing it declares
 * maps to a registered kind — the caller never guesses.
 */
function resolveKind(data: Record<string, unknown>): TemplateType | null {
  const template = typeof data.template === "string" ? data.template : undefined;
  if (template !== undefined && DEFAULT_STRUCTURE.kinds[template] !== undefined) return template;
  const id = typeof data.id === "string" ? data.id : undefined;
  if (id !== undefined) {
    const kind = DEFAULT_STRUCTURE.typeForId(id);
    if (kind !== undefined) return kind;
  }
  return null;
}

/**
 * Inspect a PostToolUse write and, when the written file is an authoring
 * artifact, file it into the env-resolved vault itself (ADR-0038 in-child
 * capture). The bridge payload carries no injected-skill identity, so the kind
 * comes from the written file's own frontmatter. A markdown write whose
 * frontmatter carries an `id`/`template` but no recognizable kind is
 * artifact-shaped-but-uncapturable: warn. Anything else (no path, unreadable,
 * no artifact frontmatter) is null.
 */
async function captureWrittenArtifact(input: HookInput): Promise<CaptureOutcome> {
  const path = input.tool_input?.file_path ?? input.tool_input?.path;
  if (path === undefined) return null;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null; // not readable — nothing to capture
  }
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data;
    body = parsed.content;
  } catch {
    return null; // not parseable frontmatter
  }
  const declaredId = typeof data.id === "string" ? data.id : undefined;
  const declaredTemplate = typeof data.template === "string" ? data.template : undefined;
  // Not artifact-shaped (no id/template frontmatter) — an ordinary write, stay silent.
  if (declaredId === undefined && declaredTemplate === undefined) return null;

  const kind = resolveKind(data);
  if (kind === null) {
    const declared = declaredTemplate !== undefined ? `template '${declaredTemplate}'` : `id '${declaredId}'`;
    return {
      outcome: "warn",
      warning:
        `authored but not captured: ${basename(path)} declares ${declared}, which maps to no ` +
        `registered wiki kind — file it manually with 'wiki create <kind>'.`,
    };
  }
  return fileArtifact({ path, data, body, kind, declaredId, cwd: input.cwd ?? process.cwd() });
}

/**
 * File a detected artifact into the vault via the registry path: resolve the
 * vault + project, mint the next id, write the artifact verbatim under its kind's
 * folder, and stamp the source draft with the assigned id. Idempotent — a draft
 * whose declared id is already indexed in the vault is reported `captured`
 * without a second write. Kind-agnostic: it files whatever kind the frontmatter
 * declares, no hard-coded kind list beyond the registry. Warns (never throws)
 * when the vault/project cannot be resolved.
 */
async function fileArtifact(args: {
  path: string;
  data: Record<string, unknown>;
  body: string;
  kind: TemplateType;
  declaredId: string | undefined;
  cwd: string;
}): Promise<CaptureOutcome> {
  const { path, data, body, kind, declaredId, cwd } = args;
  let vaultRoot: string;
  try {
    vaultRoot = await getVaultRoot();
  } catch (error) {
    return { outcome: "warn", warning: `authored but not captured: ${basename(path)} — ${(error as Error).message}` };
  }
  const project =
    typeof data.project === "string" && data.project.length > 0 ? data.project : (await readLinkedProject(cwd)) ?? undefined;
  if (project === undefined) {
    return {
      outcome: "warn",
      warning: `authored but not captured: ${basename(path)} — no project (set frontmatter 'project' or link the repo).`,
    };
  }
  const structure = await loadStructure(vaultRoot);
  if (structure.kinds[kind] === undefined) {
    return { outcome: "warn", warning: `authored but not captured: ${basename(path)} — vault defines no '${kind}' kind.` };
  }

  // Idempotent: a declared id already indexed in the vault means this draft is
  // already filed — report captured without a duplicate write.
  if (declaredId !== undefined && (await buildIdIndex(vaultRoot, project, structure)).has(declaredId)) {
    return { outcome: "captured", context: captureContext(kind, declaredId, true) };
  }

  const directory = artifactDirectory(kind, vaultRoot, project, structure);
  await mkdir(directory, { recursive: true }); // nextId reads this dir; create it first
  const id = await nextId(kind, vaultRoot, project, structure);
  const title = typeof data.title === "string" && data.title.length > 0 ? data.title : id;
  const today = new Date().toISOString().slice(0, 10);
  const aliases = Array.isArray(data.aliases) ? [...new Set([id, ...data.aliases.map(String)])] : [id];
  const fields = { ...data, id, project, aliases, created: data.created ?? today, updated: today };
  const filePath = join(directory, `${id}-${slugifyTitle(title)}.md`);
  await writeFile(filePath, matter.stringify(body, fields), { flag: "wx" });

  // Stamp the source draft with the assigned id so a re-fire is idempotent.
  await writeFile(path, matter.stringify(body, { ...data, id, project }));
  return { outcome: "captured", context: captureContext(kind, id, false) };
}

/** Context injected after a capture so the model knows the artifact is filed. */
function captureContext(kind: TemplateType, id: string, existed: boolean): string {
  return existed
    ? `A wiki '${kind}' artifact (${id}) is already filed in the vault — no action needed.`
    : `Captured a wiki '${kind}' artifact into the vault as ${id} — no need to run 'wiki create'.`;
}

/**
 * The skill being invoked, drawn from whichever signal the runtime provides:
 * Claude Code's `skill_name`, a pi `read` of a `SKILL.md` (→ its folder name),
 * or a `/skill:<name>` slash-command in the prompt (Codex, pi). Null when none
 * names a registered authoring skill, so the caller injects nothing.
 */
/** Authoring skills the bundled kinds register, for prompt scanning. Hooks fire
 *  in an arbitrary cwd with no resolved vault, so they read the bundled default
 *  rather than a per-vault wiki.json — the reminder is advisory, not vault state. */
function registeredSkills(): string[] {
  return Object.values(DEFAULT_STRUCTURE.kinds)
    .map((spec) => spec.skill)
    .filter((skill): skill is string => skill !== undefined);
}

function extractSkill(input: HookInput): string | null {
  const named = input.tool_input?.skill_name;
  if (named !== undefined && DEFAULT_STRUCTURE.kindForSkill(named) !== undefined) return named;

  const path = input.tool_input?.path;
  if (path !== undefined && basename(path) === "SKILL.md") {
    const skill = basename(dirname(path));
    if (DEFAULT_STRUCTURE.kindForSkill(skill) !== undefined) return skill;
  }

  const prompt = input.prompt;
  if (prompt !== undefined) {
    // skill names are kebab-case; match a /skill:name or /name token, not a bare mention
    for (const skill of registeredSkills()) {
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
    const capture = await captureWrittenArtifact(input);
    if (capture === null) {
      process.stdout.write("{}");
      return { code: 0 };
    }
    if (capture.outcome === "warn") {
      console.error(capture.warning); // surfaced, never a silent drop
      process.stdout.write("{}");
      return { code: 0 };
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: capture.context } }));
    return { code: 0 };
  }
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
  const kind = DEFAULT_STRUCTURE.kindForSkill(skill);
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

/** True when the wiki hook is wired in any runtime/scope — read by `doctor --setup`. */
export async function anyHookWired(cwd: string = process.cwd()): Promise<boolean> {
  for (const spec of Object.values(RUNTIMES)) {
    for (const file of [join(homedir(), spec.global), join(cwd, spec.project)]) {
      const config = await readConfig(file);
      if ([spec.event, spec.stop].some((e) => isWired(config.hooks?.[e]))) return true;
    }
  }
  return false;
}
