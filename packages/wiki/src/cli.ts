import * as fs from "node:fs";
import { parseArgs } from "node:util";
import * as path from "node:path";
import { initVault, openVault, PublicationError, WikiError, type ErrorCode, type Written } from "./vault.ts";
import { listTypes, loadRegistry, safeName, sortDiagnostics, type Diagnostic } from "./registry.ts";
import { readNote } from "./read.ts";
import { readUpdateCandidate, updateTopic, UpdateConflictError } from "./update.ts";
import { createTopic, type CreateRequest } from "./create.ts";
import { withMutationLock, MutationReleaseError, type HeldLock } from "./mutation.ts";
import { addType, publish, ValidationError } from "./publication.ts";
import { checkVault, lintVault, navigationIndexes } from "./lint.ts";
import { QMD_DEFAULT_LIMIT, type QmdFindFilters } from "./qmd.ts";
import { runSearch } from "./search.ts";
import { prepareCapture, publishTextCapture, type TextCaptureRequest, type TextCaptureCandidate } from "./capture.ts";
import { indexFreshnessDiagnostics } from "./navigation.ts";
import { doctorVault, doctorText } from "./doctor.ts";

const EXIT: Record<ErrorCode, number> = { usage: 2, conflict: 3, not_found: 4, unsupported: 5, damaged: 6, unavailable: 7 };
const USAGE = "wiki (Node source CLI)\nUsage: wiki init <dir> [--json]\n       wiki --vault <dir> init [--json]\n       wiki --vault <dir> type list [--json]\n       wiki --vault <dir> type add <name> --folder <folder> [--json]\n       wiki --vault <dir> lint [path] [--json]\n       wiki --vault <dir> index [--check] [--json]\n       wiki --vault <dir> new <type> (--project <p>|--personal) --title <t> --description <d> [--slug <s>] [--body-file <f>] [--tags <tag> ...] [--status <status>] [--json]\n       wiki --vault <dir> capture <file-or-url> (--project <p>|--personal) --title <t> --description <d> [--slug <s>] [--json]\n       wiki --vault <dir> update <canonical-path> --expect sha256:<64 lowercase hex digits> --file <complete-candidate-markdown> [--dry-run] [--json]\n       wiki --vault <dir> doctor [--json]\n       wiki --vault <dir> search sync [--embed] [--json]\n       wiki --vault <dir> find <question> [--terms <keywords>] [--deep] [--project <p>|--personal] [--type <type>] [--limit <n>] [--json]\nFast find sends one typed lex/vec qmd query without expansion or reranking; --deep explicitly expands and reranks. Path-like tokens (containing / or a dotted filename) also match canonical paths and captured note text literally; literal matches come first. Scope and type filters apply before --limit (default " + QMD_DEFAULT_LIMIT + ", the pinned qmd SDK default). Find synchronizes text but never embeds; search sync --embed fills missing embeddings. Models: explicit local GGUF paths in .wiki/config.json search.models (embed, generate, rerank). If models are not ready or vector search fails, find returns lexical results labelled degraded; a degraded miss is not exhaustive. Results render from current note bytes.\n       wiki --vault <dir> show <path> [--section <heading>] [--json]\nWhole-vault lint checks registry, frontmatter, layout, body, lifecycle, scoped titles, links, and generated-index freshness. Selected-path lint does not check generated-index freshness.\nVault: explicit directory, --vault, or WIKI_VAULT. No default vault.\n";

// Every option the parser knows. vault, json and help are global; every other option belongs to the commands that list it.
const OPTIONS = { expect: { type: "string" }, file: { type: "string" }, "dry-run": { type: "boolean" }, project: { type: "string" }, personal: { type: "boolean" }, title: { type: "string" }, description: { type: "string" }, slug: { type: "string" }, "body-file": { type: "string" }, tags: { type: "string", multiple: true }, status: { type: "string" }, vault: { type: "string" }, folder: { type: "string" }, section: { type: "string" }, terms: { type: "string" }, deep: { type: "boolean" }, type: { type: "string" }, limit: { type: "string" }, embed: { type: "boolean" }, json: { type: "boolean" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;
type OptionName = keyof typeof OPTIONS;
type OptionValues = { [K in OptionName]?: (typeof OPTIONS)[K] extends { multiple: true } ? string[] : (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };
const BODY_ONLY = "--body-file, --tags, and --status are only valid with new <type>";
type CommandSpec = {
  /** Positional arguments after the command words: [minimum, maximum]. */
  args: readonly [number, number];
  options: readonly OptionName[];
  /** Options whose absence makes the command line invalid (the full USAGE text). */
  required?: readonly OptionName[];
  /** Command-specific refusal messages that replace the group message for an option this command does not accept. */
  refusals?: Partial<Record<OptionName, string>>;
  /** Options accepted even when the positional count is wrong; the command line still fails with USAGE afterwards. */
  looseOptions?: readonly OptionName[];
};
// The table of commands and the options each accepts. Two-word keys are matched before one-word keys.
const COMMANDS = {
  init: { args: [0, 1], options: [] },
  "type list": { args: [0, 0], options: [] },
  "type add": { args: [1, 1], options: ["folder"], required: ["folder"] },
  lint: { args: [0, 1], options: [] },
  index: { args: [0, 0], options: ["check"] },
  new: { args: [1, 1], options: ["project", "personal", "title", "description", "slug", "body-file", "tags", "status"] },
  capture: { args: [1, 1], options: ["project", "personal", "title", "description", "slug"], refusals: { "body-file": BODY_ONLY, tags: BODY_ONLY, status: BODY_ONLY } },
  update: { args: [1, 1], options: ["expect", "file", "dry-run"] },
  doctor: { args: [0, 0], options: [] },
  "search sync": { args: [0, 0], options: ["embed"] },
  find: { args: [1, 1], options: ["terms", "deep", "project", "personal", "type", "limit"], looseOptions: ["project", "personal"] },
  show: { args: [1, 1], options: ["section"] },
} satisfies Record<string, CommandSpec>;
type CommandName = keyof typeof COMMANDS;
const specOf = (name: CommandName): CommandSpec => COMMANDS[name];
// Refusal groups: an option a command does not accept fails with its group message. run() checks the groups in a
// fixed order, interleaved with value checks, so the first usage message for any invalid line stays the same.
const REJECTIONS = {
  update: { options: ["expect", "file", "dry-run"], message: "Update options require update <path>" },
  create: { options: ["project", "personal", "title", "description", "slug", "body-file", "tags", "status"], message: "Create/capture options require new <type> or capture <file-or-url>" },
  embed: { options: ["embed"], message: "--embed is only valid with search sync" },
  "find-query": { options: ["terms", "deep"], message: "--terms and --deep are only valid with find <question>" },
  "find-filter": { options: ["type", "limit"], message: "--type and --limit are only valid with find <question>" },
  check: { options: ["check"], message: "--check is only valid with index" },
  section: { options: ["section"], message: "--section is only valid with show <path>" },
  folder: { options: ["folder"], message: USAGE },
} satisfies Record<string, { options: readonly OptionName[]; message: string }>;
type RejectionGroup = keyof typeof REJECTIONS;
type Selection = { name: CommandName; complete: boolean } | { name: undefined; complete: false };
function selectCommand(positionals: readonly string[]): Selection {
  const pair = positionals.slice(0, 2).join(" "), single = positionals[0] ?? "";
  const name = (Object.hasOwn(COMMANDS, pair) && pair.includes(" ") ? pair : Object.hasOwn(COMMANDS, single) && !single.includes(" ") ? single : undefined) as CommandName | undefined;
  if (name === undefined) return { name: undefined, complete: false };
  const count = positionals.length - name.split(" ").length, spec = specOf(name);
  return { name, complete: count >= spec.args[0] && count <= spec.args[1] };
}
function rejectUnaccepted(group: RejectionGroup, selection: Selection, values: OptionValues) {
  const spec = selection.name === undefined ? undefined : specOf(selection.name);
  for (const option of REJECTIONS[group].options as readonly OptionName[]) {
    if (values[option] === undefined) continue;
    const accepted = spec !== undefined && (selection.complete ? spec.options.includes(option) : spec.looseOptions?.includes(option) === true);
    if (!accepted) throw new WikiError("usage", (selection.complete ? spec?.refusals?.[option] : undefined) ?? REJECTIONS[group].message);
  }
}
type PublishedResult = { written: true } & Written;
/** Subscribes a listener to user interrupts and returns the unsubscribe function. The command subscribes only while
 * a search or a capture extraction runs, so outside those windows an interrupt keeps its default effect on the host. */
export type Interrupts = (listener: () => void) => () => void;
export interface RunOptions {
  /** Environment for vault selection (WIKI_VAULT) and for the search SDK (find, search sync, doctor), which sees it as
   * process.env while it runs. Relative paths still resolve against the process working directory. */
  env: Readonly<Record<string, string | undefined>>;
  interrupts?: Interrupts;
}
/** One command result: the exit code and the complete stdout and stderr text. */
export interface RunResult { code: number; stdout: string; stderr: string }

function writtenLines(written: Written): string {
  return "Written: " + written.paths.join(", ") + "\n" + ("digest" in written ? written.digest : JSON.stringify(written.digests)) + "\n";
}
/** The one failure-record mapper. It reads the publication record and the reported failure, never the error class chain.
 * The JSON key order is part of the documented output: partial fields, then (in run) lock cleanup and outcome, then details. */
function failureReport(actionFailure: unknown, published: PublishedResult | undefined) {
  const record = actionFailure instanceof PublicationError ? actionFailure.record : undefined;
  // A failure with a primary reports the primary's code and message (the refusal that preceded a cleanup failure).
  const failure = actionFailure instanceof PublicationError && actionFailure.primary !== undefined ? actionFailure.primary : actionFailure;
  const known = failure instanceof WikiError;
  const argumentError = failure instanceof Error && "code" in failure && typeof failure.code === "string" && failure.code.startsWith("ERR_PARSE_ARGS_");
  const code = known ? failure.code : argumentError ? "usage" : "internal";
  const written = record?.state === "written" || record?.state === "capture" ? record.written : undefined;
  const capture = record?.state === "capture" ? record : undefined;
  const partial = capture ? { retainedDirectory: capture.retainedDirectory, ...(written ? { written: true, ...written } : {}) } : written ? { written: true, ...written } : published ?? {};
  const unwrittenCleanup = record?.state === "unwritten" ? record.temporaryCleanup : undefined;
  const temporaryCleanup = capture?.temporaryCleanup ?? unwrittenCleanup;
  const diagnostics = failure instanceof ValidationError ? failure.diagnostics : undefined;
  // A capture failure never has stale-base fields, so one temporaryCleanup position after them serves both forms.
  const details = { ...(record?.state === "written" && record.temporaryPath !== undefined ? { temporaryPath: record.temporaryPath } : {}), ...(diagnostics ? { diagnostics } : {}),
    ...(failure instanceof UpdateConflictError ? { path: failure.path, expected: failure.expected, current: failure.current } : {}), ...(temporaryCleanup ? { temporaryCleanup } : {}) };
  return { code, message: failure instanceof Error ? failure.message : String(failure), exitCode: known ? EXIT[failure.code] : argumentError ? 2 : 1,
    partial, details, written, unwrittenCleanup, captureCleanup: capture?.temporaryCleanup, diagnostics };
}

/** Runs one wiki command. It does not touch process state; bin/wiki.js owns argv, env, signals, exit code and streams. */
export async function run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  let json = argv.includes("--json");
  let exitCode = 0, stdout = "", stderr = "";
  let publishedResult: PublishedResult | undefined;
  const outputBuffer: { pending?: { value: object; human: string; stderr: string } } = {};
  // Only emit after the action and required lock cleanup have both finished.
  function output(value: object, human: string, stderr = "") { outputBuffer.pending = { value, human, stderr }; }
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: OPTIONS,
    });
    json = values.json ?? false;
    if (values.help) {
      output({ ok: true, help: USAGE }, USAGE);
    } else {
      const [command, arg, ...extra] = positionals;
      const selection = selectCommand(positionals);
      const is = (name: CommandName) => selection.complete && selection.name === name;
      const reject = (group: RejectionGroup) => rejectUnaccepted(group, selection, values);
      const init = command === "init";
      const create = is("new"), update = is("update"), capture = is("capture");
      reject("update");
      if (update && (values.expect === undefined || !/^sha256:[0-9a-f]{64}$/.test(values.expect) || values.file === undefined)) throw new WikiError("usage", "Update requires --expect sha256:<64 lowercase hex digits> and --file <complete-candidate-markdown>");
      const candidate = update && values.file !== undefined ? readUpdateCandidate(values.file) : undefined;
      let request: CreateRequest | undefined;
      let captureRequest: TextCaptureRequest | undefined;
      reject("create");
      if ((create || capture) && arg !== undefined) {
        if ((values.project !== undefined) === (values.personal === true) || values.personal === false || values.title === undefined || values.description === undefined) throw new WikiError("usage", (capture ? "Capture" : "Create") + " requires exactly one explicit --project or --personal scope, --title and --description");
        if (values.project !== undefined && !safeName(values.project)) throw new WikiError("usage", "Use a safe non-reserved project name");
        let body: string | undefined;
        if (values["body-file"] !== undefined) {
          try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(values["body-file"])); }
          catch { throw new WikiError("usage", "Cannot read body file as valid UTF-8"); }
        }
        const scope = values.project === undefined ? "personal" : "projects/" + values.project;
        if (capture) {
          const slug = values.slug ?? values.title.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          captureRequest = { input: arg, scope, title: values.title, description: values.description, slug };
        } else request = { type: arg, scope, title: values.title, description: values.description, slug: values.slug, body, tags: values.tags, status: values.status };
      }
      const list = is("type list"), add = is("type add") && values.folder !== undefined, index = is("index");
      const sync = is("search sync"), doctor = is("doctor"), find = is("find") && arg !== undefined, show = is("show");
      reject("embed");
      reject("find-query");
      if (find && (!arg.trim() || values.terms !== undefined && !values.terms.trim())) throw new WikiError("usage", "find requires a nonempty question and nonempty --terms when given");
      reject("find-filter");
      if (find && (values.project !== undefined && values.personal !== undefined || values.personal === false || values.project !== undefined && !safeName(values.project))) throw new WikiError("usage", "find accepts at most one of --project <safe-project-name> or --personal");
      if (find && values.limit !== undefined && !(/^[1-9][0-9]*$/.test(values.limit) && Number.isSafeInteger(Number(values.limit)))) throw new WikiError("usage", "--limit must be a positive integer");
      if (find && values.type !== undefined && !safeName(values.type)) throw new WikiError("usage", "--type must be a registered type name");
      reject("check");
      reject("section");
      if (!selection.complete || specOf(selection.name).required?.some(option => values[option] === undefined)) throw new WikiError("usage", USAGE);
      reject("folder");
      if (init && values.vault !== undefined && arg !== undefined && path.resolve(values.vault) !== path.resolve(arg)) {
        throw new WikiError("usage", "Conflicting vault selections: --vault and init <dir> name different directories");
      }
      const selected = values.vault ?? (init ? arg : undefined) ?? options.env.WIKI_VAULT;
      if (!selected || selected.trim() === "" || selected.includes("\0")) throw new WikiError("usage", "Select a vault with init <dir>, --vault <dir>, or WIKI_VAULT; no default vault exists");
      if (init) {
        const vault = initVault(selected);
        output({ ok: true, vault }, "Initialized profile vault: " + vault.root + "\n");
      } else if (doctor) {
        const report = await doctorVault(selected, options.env);
        if (report.error) exitCode = EXIT[report.error.code];
        output(report, doctorText(report));
      } else {
        const vault = openVault(selected), root = vault.root;
        if (sync || find) {
          // find --type loads the registry once here and hands it to the vault scan.
          const registry = find && values.type !== undefined ? loadRegistry(root) : undefined;
          if (registry && !registry.types.some(t => t.record.name === values.type)) throw new WikiError("usage", "--type must name a registered type: " + values.type);
          const controller = new AbortController();
          const abort = () => controller.abort(new Error("Search " + (find ? "find" : "synchronization") + " interrupted"));
          const unsubscribe = options.interrupts?.(abort);
          try {
            const filters: QmdFindFilters = { ...(values.personal ? { scope: "personal" as const } : values.project !== undefined ? { scope: `projects/${values.project}` as const } : {}), ...(values.type !== undefined ? { type: values.type } : {}), ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}) };
            const report = await runSearch(root, find ? { kind: "find", question: arg, terms: values.terms, deep: values.deep === true, filters } : { kind: "sync", embed: values.embed === true }, options.env, controller.signal, registry);
            if (report.failure) exitCode = EXIT[report.failure];
            output(report.value, report.human, report.stderr);
          } finally { unsubscribe?.(); }
        } else {
          // Extraction, including the only input read, finishes before acquiring the mutation lock.
          let preparedCapture: TextCaptureCandidate | undefined;
          if (captureRequest) {
            const controller = new AbortController();
            const abort = () => controller.abort();
            const unsubscribe = options.interrupts?.(abort);
            try { preparedCapture = await prepareCapture(vault, captureRequest, controller.signal); }
            finally { unsubscribe?.(); }
          }
          const updateOutput = (result: ReturnType<typeof updateTopic>) => output({ ok: true, ...result }, (result.outcome === "updated" ? "Updated topic: " : result.outcome === "dry-run" ? "Dry-run topic: " : "Unchanged topic: ") + result.path + "\n" + result.digest + "\n" + JSON.stringify(result.summary) + "\n" + JSON.stringify(result.diff) + "\nNavigation: " + result.navigation + "; log: " + result.log + "\n");
          const lintFailure = (diagnostics: readonly Diagnostic[]) => {
            exitCode = 1;
            const error = { code: "lint", message: "Wiki validation failed" };
            output({ ok: false, error, diagnostics }, "", diagnostics.map(d => d.path + ": " + d.rule + ": " + d.message + "; fix: " + d.fix).join("\n") + "\n");
          };
          const indexOutput = (indexes: ReadonlyMap<string, unknown>) => {
            const paths = [...indexes.keys()].sort();
            output({ ok: true, paths, checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", "generated-index"] }, values.check ? "Generated indexes are current\n" : "Generated navigation: " + paths.join(", ") + "\n");
          };
          /** Commands that change vault bytes. Runs only inside withMutationLock, so every writer gets the held lock. */
          const executeWrite = (lock: HeldLock) => {
            if (preparedCapture) {
              const result = publishTextCapture(lock, preparedCapture);
              publishedResult = { written: true, paths: result.paths, digests: result.digests };
              output({ ok: true, ...result }, "Captured source: " + result.path + "\n" + Object.entries(result).filter(([key, value]) => typeof value === "string" || key === "limitations").map(([key, value]) => key + ": " + (Array.isArray(value) ? value.join("; ") : value)).join("\n") + "\n");
            } else if (update && arg !== undefined && values.expect !== undefined && candidate) {
              const result = updateTopic({ dryRun: false, lock }, arg, values.expect, candidate);
              if (result.outcome === "updated") publishedResult = { written: true, paths: [result.path], digest: result.digest };
              updateOutput(result);
            } else if (request) {
              const result = createTopic(lock, request);
              publishedResult = { written: true, paths: [result.path], digest: result.digest };
              output({ ok: true, ...result }, "Created topic: " + result.path + "\nTitle: " + result.title + "\nDescription: " + result.description + "\n" + result.digest + "\n");
            } else if (add && extra[0] !== undefined && values.folder !== undefined) {
              const added = addType(lock, extra[0], values.folder);
              publishedResult = { written: true, paths: [added.path], digest: added.digest };
              output({ ok: true, path: added.path }, "Created registry scaffold: " + added.path + "; review and run whole-vault lint before commit\n");
            } else if (index) {
              // Regeneration validates inside the publication module, under the held lock.
              const published = publish(lock, { kind: "index" });
              if (published.state === "refused") lintFailure(published.diagnostics);
              else {
                if (published.written.paths.length) publishedResult = { written: true, ...published.written };
                indexOutput(published.indexes);
              }
            } else throw new Error("Write dispatcher reached a read-only command");
          };
          /** Commands that never change vault bytes and never take the mutation lock. */
          const executeRead = () => {
            if (update && arg !== undefined && values.expect !== undefined && candidate) {
              updateOutput(updateTopic({ dryRun: true, vault }, arg, values.expect, candidate));
            } else if (show && arg !== undefined) {
              const note = readNote(vault, arg, values.section);
              output({ ok: true, ...note }, note.markdown);
            } else {
              const registry = list ? loadRegistry(root) : undefined;
              // --check only compares current bytes.
              const checked = index ? checkVault(root) : undefined;
              const indexes = checked ? navigationIndexes(checked) : undefined;
              const found = registry ? registry.diagnostics : checked ? checked.diagnostics : lintVault(vault, arg);
              // Index freshness is checked only over a clean inventory; the validated list stays unchanged.
              const diagnostics = indexes && !found.length ? sortDiagnostics([...found, ...indexFreshnessDiagnostics(root, indexes)]) : found;
              if (diagnostics.length) lintFailure(diagnostics);
              else if (indexes) indexOutput(indexes);
              else if (registry) {
                const types = listTypes(registry.types);
                output({ ok: true, types }, types.map(t => t.name + " folder=" + t.folder + " required=" + t.requiredFields.join(",") + " headings=" + t.requiredHeadings.map(h => h.level + ":" + h.text).join(",") + " scopes=" + (t.scopes?.join(",") ?? "all")).join("\n") + "\n");
              } else output({ ok: true, diagnostics: [], checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", ...(arg === undefined ? ["generated-index"] : [])] }, "Wiki lint passed (registry, frontmatter, layout, body, lifecycle, scoped titles, links; generated-index freshness " + (arg === undefined ? "checked" : "not checked for selected paths") + ")\n");
            }
          };
          // The one lock rule: these commands write the vault; everything else is a read.
          if (update && !values["dry-run"] || create || capture || add || index && !values.check) withMutationLock(root, executeWrite);
          else executeRead();
        }
      }
    }
  } catch (error) {
    const release = error instanceof MutationReleaseError ? error : undefined;
    const cleanup = release ? { path: ".wiki/locks/mutation.lock", retained: true, message: release.cause instanceof Error ? release.cause.message : String(release.cause) } : undefined;
    const pending = outputBuffer.pending;
    delete outputBuffer.pending;
    const actionFailure = release?.outcome.kind === "failed" ? release.outcome.error : error;
    if (release?.outcome.kind === "completed" && pending && "ok" in pending.value && pending.value.ok === false) {
      output({ ...pending.value, cleanup }, pending.human, pending.stderr + release.message + "\n");
    } else {
      const report = failureReport(actionFailure, publishedResult);
      exitCode = report.exitCode;
      output({ ok: false, error: { code: report.code, message: report.message }, ...report.partial, ...(cleanup ? { cleanup } : {}), ...(release?.outcome.kind === "completed" && publishedResult ? { outcome: "completed" } : {}), ...report.details }, "");
      if (!json) {
        stderr += report.code + ": " + report.message + "\n";
        if (report.unwrittenCleanup) stderr += "Temporary cleanup: " + report.unwrittenCleanup.message + "\n";
        if (cleanup) stderr += "Lock cleanup: " + cleanup.message + "; retained " + cleanup.path + "\n";
        if (publishedResult) stderr += writtenLines(publishedResult);
        if (report.written) stderr += writtenLines(report.written);
        if (report.captureCleanup) stderr += "Temporary cleanup: " + report.captureCleanup.message + "\n";
        if (report.diagnostics) stderr += report.diagnostics.map(d => d.path + ": " + d.rule + ": " + d.message + "; fix: " + d.fix).join("\n") + "\n";
      }
    }
  }
  const pending = outputBuffer.pending;
  if (pending) {
    stdout += json ? JSON.stringify(pending.value) + "\n" : pending.human;
    if (!json && pending.stderr) stderr += pending.stderr;
  }
  return { code: exitCode, stdout, stderr };
}
