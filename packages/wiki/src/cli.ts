import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import * as path from "node:path";
import { initVault, WikiError, ExclusiveCleanupError, ExclusiveTemporaryError, type ErrorCode } from "./vault.ts";
import { addType, listTypes, loadRegistry, openVault, RegistryWriteError, safeName, sortDiagnostics } from "./registry.ts";
import { readNote } from "./read.ts";
import { readUpdateCandidate, updateTopic, UpdateConflictError, UpdateTemporaryError } from "./update.ts";
import { createTopic, CreatePartialError, CreateValidationError, type CreateRequest } from "./create.ts";
import { withMutationLock, MutationReleaseError } from "./mutation.ts";
import { inspectVault, lintVault } from "./lint.ts";
import { QMD_DEFAULT_LIMIT, type QmdFindFilters } from "./qmd.ts";
import { runSearch } from "./search.ts";
import { prepareCapture, publishTextCapture, CaptureValidationError, CapturePublicationError, type TextCaptureRequest, type TextCaptureCandidate } from "./capture.ts";
import { indexDestinationDiagnostics, indexFreshnessDiagnostics } from "./navigation.ts";
import { doctorVault, doctorText } from "./doctor.ts";

const EXIT: Record<ErrorCode, number> = { usage: 2, conflict: 3, not_found: 4, unsupported: 5, damaged: 6, unavailable: 7 };
const USAGE = "wiki (Node source CLI)\nUsage: wiki init <dir> [--json]\n       wiki --vault <dir> init [--json]\n       wiki --vault <dir> type list [--json]\n       wiki --vault <dir> type add <name> --folder <folder> [--json]\n       wiki --vault <dir> lint [path] [--json]\n       wiki --vault <dir> index [--check] [--json]\n       wiki --vault <dir> new <type> (--project <p>|--personal) --title <t> --description <d> [--slug <s>] [--body-file <f>] [--tags <tag> ...] [--status <status>] [--json]\n       wiki --vault <dir> capture <file-or-url> (--project <p>|--personal) --title <t> --description <d> [--slug <s>] [--json]\n       wiki --vault <dir> update <canonical-path> --expect sha256:<64 lowercase hex digits> --file <complete-candidate-markdown> [--dry-run] [--json]\n       wiki --vault <dir> doctor [--json]\n       wiki --vault <dir> search sync [--embed] [--json]\n       wiki --vault <dir> find <question> [--terms <keywords>] [--deep] [--project <p>|--personal] [--type <type>] [--limit <n>] [--json]\nFast find sends one typed lex/vec qmd query without expansion or reranking; --deep explicitly expands and reranks. Path-like tokens (containing / or a dotted filename) also match canonical paths and captured note text literally; literal matches come first. Scope and type filters apply before --limit (default " + QMD_DEFAULT_LIMIT + ", the pinned qmd SDK default). Find synchronizes text but never embeds; search sync --embed fills missing embeddings. Models: explicit local GGUF paths in .wiki/config.json search.models (embed, generate, rerank). If models are not ready or vector search fails, find returns lexical results labelled degraded; a degraded miss is not exhaustive. Results render from current note bytes.\n       wiki --vault <dir> show <path> [--section <heading>] [--json]\nWhole-vault lint checks registry, frontmatter, layout, body, lifecycle, scoped titles, links, and generated-index freshness. Selected-path lint does not check generated-index freshness.\nVault: explicit directory, --vault, or WIKI_VAULT. No default vault.\n";
type PublishedResult = { written: true; paths: string[] } & ({ digest: string } | { digests: Record<string, string> });
/** Subscribes a listener to user interrupts and returns the unsubscribe function. The command subscribes only while
 * a search or a capture extraction runs, so outside those windows an interrupt keeps its default effect on the host. */
export type Interrupts = (listener: () => void) => () => void;
export interface RunOptions {
  /** Environment for vault selection (WIKI_VAULT). Relative paths still resolve against the process working directory. */
  env: Readonly<Record<string, string | undefined>>;
  interrupts?: Interrupts;
}
/** One command result: the exit code and the complete stdout and stderr text. */
export interface RunResult { code: number; stdout: string; stderr: string }

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
      options: { expect: { type: "string" }, file: { type: "string" }, "dry-run": { type: "boolean" }, project: { type: "string" }, personal: { type: "boolean" }, title: { type: "string" }, description: { type: "string" }, slug: { type: "string" }, "body-file": { type: "string" }, tags: { type: "string", multiple: true }, status: { type: "string" }, vault: { type: "string" }, folder: { type: "string" }, section: { type: "string" }, terms: { type: "string" }, deep: { type: "boolean" }, type: { type: "string" }, limit: { type: "string" }, embed: { type: "boolean" }, json: { type: "boolean" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
    json = values.json ?? false;
    if (values.help) {
      output({ ok: true, help: USAGE }, USAGE);
    } else {
      const [command, arg, ...extra] = positionals;
      const init = command === "init";
      const create = command === "new" && arg !== undefined && extra.length === 0;
      const update = command === "update" && arg !== undefined && extra.length === 0;
      const capture = command === "capture" && arg !== undefined && extra.length === 0;
      if (!update && [values.expect, values.file, values["dry-run"]].some(v => v !== undefined)) throw new WikiError("usage", "Update options require update <path>");
      if (update && (values.expect === undefined || !/^sha256:[0-9a-f]{64}$/.test(values.expect) || values.file === undefined)) throw new WikiError("usage", "Update requires --expect sha256:<64 lowercase hex digits> and --file <complete-candidate-markdown>");
      const candidate = update && values.file !== undefined ? readUpdateCandidate(values.file) : undefined;
      let request: CreateRequest | undefined;
      let captureRequest: TextCaptureRequest | undefined;
      const finding = positionals[0] === "find";
      if (!create && !capture && [...(finding ? [] : [values.project, values.personal]), values.title, values.description, values.slug, values["body-file"], values.tags, values.status].some(v => v !== undefined)) throw new WikiError("usage", "Create/capture options require new <type> or capture <file-or-url>");
      if (capture && [values["body-file"], values.tags, values.status].some(v => v !== undefined)) throw new WikiError("usage", "--body-file, --tags, and --status are only valid with new <type>");
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
      const list = command === "type" && arg === "list" && extra.length === 0;
      const add = command === "type" && arg === "add" && extra.length === 1 && values.folder !== undefined;
      const index = command === "index" && arg === undefined && extra.length === 0;
      const sync = command === "search" && arg === "sync" && extra.length === 0;
      const doctor = command === "doctor" && arg === undefined && extra.length === 0;
      const find = command === "find" && arg !== undefined && extra.length === 0;
      if (values.embed !== undefined && !sync) throw new WikiError("usage", "--embed is only valid with search sync");
      if ((values.terms !== undefined || values.deep !== undefined) && !find) throw new WikiError("usage", "--terms and --deep are only valid with find <question>");
      if (find && (!arg.trim() || values.terms !== undefined && !values.terms.trim())) throw new WikiError("usage", "find requires a nonempty question and nonempty --terms when given");
      if ((values.type !== undefined || values.limit !== undefined) && !find) throw new WikiError("usage", "--type and --limit are only valid with find <question>");
      if (find && (values.project !== undefined && values.personal !== undefined || values.personal === false || values.project !== undefined && !safeName(values.project))) throw new WikiError("usage", "find accepts at most one of --project <safe-project-name> or --personal");
      if (find && values.limit !== undefined && !(/^[1-9][0-9]*$/.test(values.limit) && Number.isSafeInteger(Number(values.limit)))) throw new WikiError("usage", "--limit must be a positive integer");
      if (find && values.type !== undefined && !safeName(values.type)) throw new WikiError("usage", "--type must be a registered type name");
      if (values.check !== undefined && !index) throw new WikiError("usage", "--check is only valid with index");
      const show = command === "show" && arg !== undefined && extra.length === 0;
      if (values.section !== undefined && !show) throw new WikiError("usage", "--section is only valid with show <path>");
      if (!(doctor || sync || find || update || create || capture || show || index || init && extra.length === 0 || list || add || command === "lint" && extra.length === 0) || values.folder !== undefined && !add) throw new WikiError("usage", USAGE);
      if (init && values.vault !== undefined && arg !== undefined && path.resolve(values.vault) !== path.resolve(arg)) {
        throw new WikiError("usage", "Conflicting vault selections: --vault and init <dir> name different directories");
      }
      const selected = values.vault ?? (init ? arg : undefined) ?? options.env.WIKI_VAULT;
      if (!selected || selected.trim() === "" || selected.includes("\0")) throw new WikiError("usage", "Select a vault with init <dir>, --vault <dir>, or WIKI_VAULT; no default vault exists");
      if (init) {
        const vault = initVault(selected);
        output({ ok: true, vault }, "Initialized profile vault: " + vault.root + "\n");
      } else if (doctor) {
        const report = await doctorVault(selected);
        if (report.error) exitCode = EXIT[report.error.code];
        output(report, doctorText(report));
      } else {
        const root = openVault(selected);
        if (sync || find) {
          // find --type loads the registry once here and hands it to the vault scan.
          const registry = find && values.type !== undefined ? loadRegistry(root) : undefined;
          if (registry && !registry.types.some(t => t.record.name === values.type)) throw new WikiError("usage", "--type must name a registered type: " + values.type);
          const controller = new AbortController();
          const abort = () => controller.abort(new Error("Search " + (find ? "find" : "synchronization") + " interrupted"));
          const unsubscribe = options.interrupts?.(abort);
          try {
            const filters: QmdFindFilters = { ...(values.personal ? { scope: "personal" as const } : values.project !== undefined ? { scope: `projects/${values.project}` as const } : {}), ...(values.type !== undefined ? { type: values.type } : {}), ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}) };
            const report = await runSearch(root, find ? { kind: "find", question: arg, terms: values.terms, deep: values.deep === true, filters } : { kind: "sync", embed: values.embed === true }, controller.signal, registry);
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
            try { preparedCapture = await prepareCapture(root, captureRequest, controller.signal); }
            finally { unsubscribe?.(); }
          }
          const execute = () => {
            if (preparedCapture) {
              const result = publishTextCapture(root, preparedCapture);
              publishedResult = { written: true, paths: result.paths, digests: result.digests };
              output({ ok: true, ...result }, "Captured source: " + result.path + "\n" + Object.entries(result).filter(([key, value]) => typeof value === "string" || key === "limitations").map(([key, value]) => key + ": " + (Array.isArray(value) ? value.join("; ") : value)).join("\n") + "\n");
            } else if (update && arg !== undefined && values.expect !== undefined && candidate) {
              const result = updateTopic(root, arg, values.expect, candidate, values["dry-run"] === true);
              if (result.outcome === "updated") publishedResult = { written: true, paths: [result.path], digest: result.digest };
              output({ ok: true, ...result }, (result.outcome === "updated" ? "Updated topic: " : result.outcome === "dry-run" ? "Dry-run topic: " : "Unchanged topic: ") + result.path + "\n" + result.digest + "\n" + JSON.stringify(result.summary) + "\n" + JSON.stringify(result.diff) + "\nNavigation: " + result.navigation + "; log: " + result.log + "\n");
            } else if (request) {
              const result = createTopic(root, request);
              publishedResult = { written: true, paths: [result.path], digest: result.digest };
              output({ ok: true, ...result }, "Created topic: " + result.path + "\nTitle: " + result.title + "\nDescription: " + result.description + "\n" + result.digest + "\n");
            } else if (show && arg !== undefined) {
              const note = readNote(root, arg, values.section);
              output({ ok: true, ...note }, note.markdown);
            } else if (add && extra[0] !== undefined && values.folder !== undefined) {
              const added = addType(root, extra[0], values.folder);
              publishedResult = { written: true, paths: [added.path], digest: added.digest };
              output({ ok: true, path: added.path }, "Created registry scaffold: " + added.path + "; review and run whole-vault lint before commit\n");
            } else {
              const registry = list ? loadRegistry(root) : undefined;
              const inventory = index ? inspectVault(root) : undefined;
              const diagnostics = registry ? registry.diagnostics : inventory ? inventory.diagnostics : lintVault(root, arg);
              if (inventory && !diagnostics.length) {
                diagnostics.push(...(values.check ? indexFreshnessDiagnostics(root, inventory.indexes) : indexDestinationDiagnostics(root, inventory.indexes.keys())));
                sortDiagnostics(diagnostics);
              }
              if (diagnostics.length) {
                exitCode = 1;
                const error = { code: "lint", message: "Wiki validation failed" };
                output({ ok: false, error, diagnostics }, "", diagnostics.map(d => d.path + ": " + d.rule + ": " + d.message + "; fix: " + d.fix).join("\n") + "\n");
              } else if (inventory) {
                if (!values.check) {
                  const paths: string[] = [], digests: Record<string, string> = {};
                  for (const [relative, bytes] of inventory.indexes) {
                    fs.writeFileSync(path.join(root, relative), bytes);
                    paths.push(relative);
                    digests[relative] = "sha256:" + createHash("sha256").update(bytes).digest("hex");
                    publishedResult = { written: true, paths, digests };
                  }
                }
                const paths = [...inventory.indexes.keys()].sort();
                output({ ok: true, paths, checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", "generated-index"] }, values.check ? "Generated indexes are current\n" : "Generated navigation: " + paths.join(", ") + "\n");
              } else if (registry) {
                const types = listTypes(registry.types);
                output({ ok: true, types }, types.map(t => t.name + " folder=" + t.folder + " required=" + t.requiredFields.join(",") + " headings=" + t.requiredHeadings.map(h => h.level + ":" + h.text).join(",") + " scopes=" + (t.scopes?.join(",") ?? "all")).join("\n") + "\n");
              } else output({ ok: true, diagnostics: [], checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", ...(arg === undefined ? ["generated-index"] : [])] }, "Wiki lint passed (registry, frontmatter, layout, body, lifecycle, scoped titles, links; generated-index freshness " + (arg === undefined ? "checked" : "not checked for selected paths") + ")\n");
            }
          };
          if (update && !values["dry-run"] || create || capture || add || index && !values.check) withMutationLock(root, execute);
          else execute();
        }
      }
    }
  } catch (error) {
    const release = error instanceof MutationReleaseError ? error : undefined;
    const cleanup = release ? { path: ".wiki/locks/mutation.lock", retained: true, message: release.cause instanceof Error ? release.cause.message : String(release.cause) } : undefined;
    const pending = outputBuffer.pending;
    delete outputBuffer.pending;
    const actionFailure = release?.outcome.kind === "failed" ? release.outcome.error : error;
    const temporaryCleanup = actionFailure instanceof UpdateTemporaryError || actionFailure instanceof ExclusiveTemporaryError ? { path: actionFailure.temporaryPath, retained: true, message: actionFailure.message + (actionFailure.cause instanceof Error ? ": " + actionFailure.cause.message : "") } : undefined;
    const failure = (actionFailure instanceof UpdateTemporaryError || actionFailure instanceof ExclusiveTemporaryError) && actionFailure.primary !== undefined ? actionFailure.primary : actionFailure;
    if (release?.outcome.kind === "completed" && pending && "ok" in pending.value && pending.value.ok === false) {
      output({ ...pending.value, cleanup }, pending.human, pending.stderr + release.message + "\n");
    } else {
      const known = failure instanceof WikiError;
      const argumentError = failure instanceof Error && "code" in failure && typeof failure.code === "string" && failure.code.startsWith("ERR_PARSE_ARGS_");
      const code = known ? failure.code : argumentError ? "usage" : "internal";
      const message = failure instanceof Error ? failure.message : String(failure);
      exitCode = known ? EXIT[failure.code] : argumentError ? 2 : 1;
      const partial = failure instanceof CapturePublicationError ? { retainedDirectory: failure.retainedDirectory, ...(failure.paths.length ? { written: true, paths: failure.paths, digests: failure.digests } : {}) } : failure instanceof RegistryWriteError || failure instanceof CreatePartialError || failure instanceof ExclusiveCleanupError ? { written: failure.written, paths: failure.paths, digest: failure.digest } : publishedResult ?? {};
      output({ ok: false, error: { code, message }, ...partial, ...(cleanup ? { cleanup } : {}), ...(release?.outcome.kind === "completed" && publishedResult ? { outcome: "completed" } : {}), ...(failure instanceof ExclusiveCleanupError ? { temporaryPath: failure.temporaryPath } : {}), ...(failure instanceof CreateValidationError || failure instanceof CaptureValidationError ? { diagnostics: failure.diagnostics } : {}), ...(failure instanceof CapturePublicationError && failure.temporaryCleanup ? { temporaryCleanup: failure.temporaryCleanup } : {}), ...(failure instanceof UpdateConflictError ? { path: failure.path, expected: failure.expected, current: failure.current } : {}), ...(temporaryCleanup ? { temporaryCleanup } : {}) }, "");
      if (!json) {
        stderr += code + ": " + message + "\n";
        if (temporaryCleanup) stderr += "Temporary cleanup: " + temporaryCleanup.message + "\n";
        if (cleanup) stderr += "Lock cleanup: " + cleanup.message + "; retained " + cleanup.path + "\n";
        if (publishedResult) stderr += "Written: " + publishedResult.paths.join(", ") + "\n" + ("digest" in publishedResult ? publishedResult.digest : JSON.stringify(publishedResult.digests)) + "\n";
        if (failure instanceof RegistryWriteError || failure instanceof CreatePartialError || failure instanceof ExclusiveCleanupError) stderr += "Written: " + failure.paths.join(", ") + "\n" + failure.digest + "\n";
        if (failure instanceof CapturePublicationError) {
          if (failure.paths.length) stderr += "Written: " + failure.paths.join(", ") + "\n" + JSON.stringify(failure.digests) + "\n";
          if (failure.temporaryCleanup) stderr += "Temporary cleanup: " + failure.temporaryCleanup.message + "\n";
        }
        if (failure instanceof CreateValidationError || failure instanceof CaptureValidationError) stderr += failure.diagnostics.map(d => d.path + ": " + d.rule + ": " + d.message + "; fix: " + d.fix).join("\n") + "\n";
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
