import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectContainedPath } from "./paths.ts";
import { inspectVault } from "./lint.ts";
import { isMapping } from "./frontmatter.ts";
import { indexFreshnessDiagnostics } from "./navigation.ts";
import type { ErrorCode } from "./vault.ts";
import { qmdModelReadiness, inspectQmdIndex, DEEP_ROLES, QMD_WRITER_LOCK, type QmdModels, type QmdModelRole } from "./qmd.ts";

type Problem = { path: string; message: string; fix: string };
type Check = { state: "ready" } | { state: "unavailable" };
type VersionCheck = { state: "ready"; version: string } | { state: "unavailable"; version?: string };
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function checked(root: string, relative: string): string {
  const inspected = inspectContainedPath(root, relative);
  if (!inspected.ok) throw new Error(inspected.problem.message);
  return inspected.full;
}
function readJson(root: string, relative: string): unknown { return JSON.parse(fs.readFileSync(checked(root, relative), "utf8")); }

/** Delegate all file/configuration validation to search's model-free preflight.
 * Request each role separately so a missing deep-only model does not hide embed readiness. */
function doctorModelReadiness(root: string, problems: Problem[]) {
  const models: QmdModels = {};
  const checks: Record<QmdModelRole, Check> = { embed: { state: "unavailable" }, generate: { state: "unavailable" }, rerank: { state: "unavailable" } };
  const diagnostics = new Map<string, Problem>();
  for (const role of DEEP_ROLES) {
    const readiness = qmdModelReadiness(root, [role]);
    if (readiness.state === "ready") {
      models[role] = readiness.models[role]; checks[role] = { state: "ready" };
    } else {
      for (const diagnostic of readiness.diagnostics) diagnostics.set(diagnostic.path + "\n" + diagnostic.message, {
        ...diagnostic, fix: "Configure an existing readable absolute local GGUF file in search.models. File readiness does not prove inference compatibility; doctor never resolves or downloads models",
      });
    }
  }
  problems.push(...diagnostics.values());
  return { models, checks };
}

const EXTRACTOR_PROBES = {
  pandoc: { args: ["--version"], version: /^pandoc\s+(\S+)/m },
  pdftotext: { args: ["-v"], version: /pdftotext version\s+(\S+)/ },
} as const;

function extractor(command: keyof typeof EXTRACTOR_PROBES, problems: Problem[]): VersionCheck {
  const probe = EXTRACTOR_PROBES[command];
  const result = spawnSync(command, probe.args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
  const output = result.stdout + "\n" + result.stderr;
  const version = probe.version.exec(output)?.[1];
  if (!result.error && result.status === 0 && version) return { state: "ready", version };
  problems.push({ path: command, message: command + " unavailable: " + (result.error?.message ?? "No successful version response"), fix: "Supply a working " + command + " on PATH; doctor does not install or run extraction" });
  return { state: "unavailable" };
}

type ReportProblem = (file: string, text: string, fix: string, code?: ErrorCode) => void;
const REQUIRED_LAYOUT = [["", "directory"], [".wiki", "directory"], [".wiki/config.json", "file"], [".wiki/types", "directory"], [".wiki/tmp", "directory"], [".wiki/locks", "directory"], ["index.md", "file"], ["log.md", "file"], [".gitignore", "file"]] as const;

const HAS_KIND = { directory: (stat: fs.Stats) => stat.isDirectory(), file: (stat: fs.Stats) => stat.isFile() };

function layoutEntryProblem(root: string, relative: string, kind: keyof typeof HAS_KIND): string | undefined {
  try {
    const item = inspectContainedPath(root, relative);
    if (!item.ok) return item.problem.message;
    if (!item.stat || !HAS_KIND[kind](item.stat)) return "Missing or not a " + kind;
    return undefined;
  } catch (error) { return message(error); }
}

/** Reports every missing or wrong-kind layout entry; ready only when none is reported. */
function layoutCheck(root: string, problem: ReportProblem): Check {
  let ready = true;
  for (const [relative, kind] of REQUIRED_LAYOUT) {
    const text = layoutEntryProblem(root, relative, kind);
    if (text !== undefined) { ready = false; problem(relative, text, "Inspect incomplete layout and retained files before explicit repair; doctor changes nothing"); }
  }
  return { state: ready ? "ready" : "unavailable" };
}

function retainedLockProblems(root: string, problem: ReportProblem): void {
  for (const relative of [".wiki/locks/mutation.lock", QMD_WRITER_LOCK]) {
    // throwIfNoEntry suppresses only ENOENT: an absent lock is the healthy state.
    try { if (fs.lstatSync(checked(root, relative), { throwIfNoEntry: false })) problem(relative, "Retained writer lock; inspection cannot certify a stable inventory", "Inspect ownership and verify no cooperating owner is active before explicit removal; never remove based on age", "conflict"); }
    catch (error) { problem(relative, message(error), "Inspect retained lock without reclaiming it"); }
  }
}

function retainedTemporaryProblems(root: string, problem: ReportProblem): void {
  try {
    const temporary = fs.readdirSync(checked(root, ".wiki/tmp"));
    for (const name of temporary.sort()) problem(".wiki/tmp/" + name, "Retained temporary entry; a previous operation may be partial", "Inspect retained bytes, published paths, log.md and generated indexes before explicit cleanup; do not blindly retry publication");
  } catch (error) { problem(".wiki/tmp", message(error), "Inspect retained temporary state manually"); }
}

function nodeCheck(problem: ReportProblem): VersionCheck {
  const version = process.versions.node;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 22 || major === 22 && minor >= 18) return { state: "ready", version };
  problem("node", "Node >=22.18 is required; actual " + version, "Run the source CLI under a supported Node runtime", "unavailable");
  return { state: "unavailable", version };
}

function indexReadProblems(root: string, indexes: Iterable<[string, string]>): ReturnType<typeof indexFreshnessDiagnostics> {
  const problems: ReturnType<typeof indexFreshnessDiagnostics> = [];
  for (const [relative, bytes] of indexes) {
    try { problems.push(...indexFreshnessDiagnostics(root, new Map([[relative, bytes]]))); }
    catch (error) {
      problems.push({ path: relative, rule: "index.unreadable", message: message(error), fix: "Restore readable regular generated-index files, then run index explicitly if needed; doctor does not regenerate navigation" });
    }
  }
  return problems;
}

/** Navigation freshness is judged only over a clean inventory. */
function navigationCheck(root: string, inventory: ReturnType<typeof inspectVault> | undefined, problem: ReportProblem): Check {
  if (!inventory || inventory.diagnostics.length) return { state: "unavailable" };
  const problems = indexReadProblems(root, inventory.indexes);
  for (const d of problems) problem(d.path, d.rule + ": " + d.message, d.fix);
  return { state: problems.length ? "unavailable" : "ready" };
}

/** Inspect only. No writer lock, synchronization, note publication, or SDK model resolution. */
export async function doctorVault(selected: string) {
  const root = path.resolve(selected), diagnostics: Problem[] = [];
  let failure: ErrorCode | undefined;
  const problem: ReportProblem = (file, text, fix, code = "damaged") => {
    diagnostics.push({ path: file, message: text, fix }); failure ??= code;
  };
  const rootEntry = inspectContainedPath(root, "");
  if (!rootEntry.ok) problem(root, rootEntry.problem.message, "Select a regular explicit vault directory", "usage");
  else if (!rootEntry.stat) problem(root, "Missing requested vault", "Select an existing profile vault; doctor does not initialize directories", "not_found");
  else if (!rootEntry.stat.isDirectory()) problem(root, "Vault is not a directory", "Select a regular explicit vault directory", "usage");
  let profile: Check = { state: "unavailable" };
  try {
    const config = readJson(root, ".wiki/config.json");
    if (!isMapping(config) || !("profile" in config) || !("version" in config)) throw new Error("Configuration requires profile and version");
    if (config.profile !== "wiki-okf" || config.version !== 1) problem(".wiki/config.json", "Unsupported profile/version; expected wiki-okf version 1", "Select a compatible explicit vault; no conversion or reinitialization performed", "unsupported");
    else profile = { state: "ready" };
  } catch (error) { problem(".wiki/config.json", message(error), "Inspect retained configuration and restore valid wiki-okf version 1 JSON explicitly; do not reinitialize over retained files"); }
  const layout = layoutCheck(root, problem);
  let inventory: ReturnType<typeof inspectVault> | undefined;
  let registry: Check = { state: "unavailable" };
  if (profile.state === "ready") {
    try {
      const directory = inspectContainedPath(root, ".wiki/types");
      if (!directory.ok) throw new Error(directory.problem.message);
      if (!directory.stat?.isDirectory() || !fs.readdirSync(directory.full).some(name => name.endsWith(".json"))) throw new Error("Missing registry records in .wiki/types");
      inventory = inspectVault(root);
      const issues = inventory.diagnostics;
      registry = { state: issues.some(d => d.rule.startsWith("registry.")) ? "unavailable" : "ready" };
      for (const d of issues) problem(d.path, d.rule + ": " + d.message, d.fix);
    } catch (error) { problem(".wiki/types", message(error), "Restore readable compatible registry records and files; no scaffolds are installed"); }
  }
  const navigation = navigationCheck(root, inventory, problem);
  retainedLockProblems(root, problem);
  retainedTemporaryProblems(root, problem);
  const node = nodeCheck(problem);
  const extractors = { pandoc: extractor("pandoc", diagnostics), pdftotext: extractor("pdftotext", diagnostics) };
  const modelReadiness = doctorModelReadiness(root, diagnostics);
  const { qmd, database, textCoverage, embeddingCoverage } = await inspectQmdIndex(root, profile.state === "ready" ? inventory : undefined, modelReadiness.models, problem, diagnostics);
  if (diagnostics.length) failure ??= "unavailable";
  return {
    ok: failure === undefined,
    ...(failure ? { error: { code: failure, message: "Foundation readiness has diagnostics; no repairs performed" } } : {}),
    root, profile, layout, registry, navigation, runtime: { node, qmd }, extractors, models: modelReadiness.checks,
    search: { database, textCoverage, embeddingCoverage },
    coverageBasis: "captured-inventory; no timestamp freshness guarantee", sourceCorrectness: "not-asserted", diagnostics,
  };
}

export function doctorText(report: Awaited<ReturnType<typeof doctorVault>>): string {
  const version = (check: VersionCheck) => check.state + (check.version ? " (" + check.version + ")" : "");
  return "Foundation inspection: " + (report.ok ? "completed" : "diagnostics") + " (read-only)\n" +
    "Node: " + version(report.runtime.node) + "\nqmd/native: " + version(report.runtime.qmd) + "\n" +
    Object.entries(report.extractors).map(([name, check]) => name + ": " + version(check) + "\n").join("") +
    "Profile: " + report.profile.state + "; layout: " + report.layout.state + "; registry: " + report.registry.state + "; navigation: " + report.navigation.state + "\n" +
    "Local database: " + report.search.database.state + "\nText coverage: " + report.search.textCoverage.state + "\nEmbedding coverage: " + report.search.embeddingCoverage.state + "\n" +
    "Coverage: captured inventory only, not timestamp freshness or source correctness. No repairs performed.\n" +
    report.diagnostics.map(d => d.path + ": " + d.message + "; fix: " + d.fix + "\n").join("");
}
