import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DedupBlockedError,
  fieldsForDedupOverride,
  formatDedupBlocked,
  parseDedupOverride,
  QmdError,
  runDedupGate,
} from "../../artifacts/dedup";
import { decideTransition } from "../../artifacts/transitions";
import {
  appendField,
  ArtifactNotFoundError,
  ArtifactValidationError,
  createArtifact,
  readArtifact,
  setField,
  setFields,
  type Artifact,
} from "../../artifacts/store";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";
import { phaseDocOptions, writePhaseDocToStderr } from "../phase-docs";

const reviewVerdicts = new Set(["pass", "pass-with-notes", "reject"]);

export async function handleSlice(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createSlice(rest);
  }
  if (subverb === "show") {
    return showSlice(rest);
  }
  if (subverb === "set") {
    return setSlice(rest);
  }
  if (subverb === "append") {
    return appendSlice(rest);
  }
  if (subverb === "red") {
    return runTestTransition(rest, "red");
  }
  if (subverb === "green") {
    return runTestTransition(rest, "green");
  }
  if (subverb === "close") {
    return closeSlice(rest);
  }
  console.error(`unknown slice subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function createSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "project", "parent-prd", "force-new", "related-to", "supersedes"]);
  const project = stringValue(parsed.values, "project");
  const title = stringValue(parsed.values, "title");
  const parentPrd = stringValue(parsed.values, "parent-prd");
  const required = { project, title, "parent-prd": parentPrd };
  const missing = Object.entries(required).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }

  if (project === undefined || title === undefined || parentPrd === undefined) {
    return { code: 1 };
  }

  const override = parseDedupOverride({
    forceNew: stringValue(parsed.values, "force-new"),
    relatedTo: stringValue(parsed.values, "related-to"),
    supersedes: stringValue(parsed.values, "supersedes"),
  });
  if (typeof override === "string") {
    console.error(override);
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  await assertProjectStructure(projectPath);
  const parentPrdPath = join(projectPath, "prds", `${parentPrd}.md`);
  if (!(await fileExists(parentPrdPath))) {
    console.error(`parent PRD not found: ${parentPrd}`);
    return { code: 1 };
  }

  try {
    if (override.kind === "supersedes") {
      await readArtifact({ type: "slice", vaultRoot, project, id: override.id });
    }
    const config = await loadProjectConfig(projectPath);
    await runDedupGate({ type: "slice", project, projectPath, config, query: `${title} ${parentPrd}`, override });
    const artifact = await createArtifact({
      type: "slice",
      vaultRoot,
      project,
      fields: { title, parent_prd: parentPrd, acceptance: [], ...fieldsForDedupOverride(override) },
    });
    if (override.kind === "supersedes") {
      await setFields({
        type: "slice",
        vaultRoot,
        project,
        id: override.id,
        fields: { superseded_by: artifact.id },
      });
    }
    console.log(artifact.id);
    console.error(`created ${artifact.id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      console.error(formatDedupBlocked(error));
      return { code: 1 };
    }
    if (error instanceof QmdError || error instanceof ProjectConfigError) {
      console.error(error.message);
      return { code: 10 };
    }
    return handleSliceError(error);
  }
}

async function appendSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const value = parsed.positionals[1];
  const project = stringValue(parsed.values, "project");
  const field = stringValue(parsed.values, "field");
  if (id === undefined || project === undefined || field === undefined || value === undefined) {
    console.error("missing required field: id, project, field, value");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    await appendField({ type: "slice", vaultRoot, project, id, field, value: parseFieldValue(field, value) });
    console.error(`updated ${id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError || error instanceof ArtifactValidationError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function setSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const rawValue = parsed.positionals[1];
  const project = stringValue(parsed.values, "project");
  const field = stringValue(parsed.values, "field");
  if (id === undefined || project === undefined || field === undefined || rawValue === undefined) {
    console.error("missing required field: id, project, field, value");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const raw = rawValue === "-" ? await Bun.stdin.text() : rawValue;
  try {
    await setField({ type: "slice", vaultRoot, project, id, field, value: parseFieldValue(field, raw) });
    console.error(`updated ${id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError || error instanceof ArtifactValidationError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function runTestTransition(args: string[], verb: "red" | "green"): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "doc-phase"], [], ["no-doc"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "slice", vaultRoot, project, id });
    const beforeRun = decideFromArtifact(artifact, verb);
    if (!beforeRun.ok) {
      console.error(beforeRun.reason);
      return { code: beforeRun.exitCode };
    }

    const config = await loadProjectConfig(join(vaultRoot, "projects", project), { requireLifecycle: true });
    const logPath = join(config.repo, ".wiki", "state", "slices", `${id}-${verb}.log`);
    const exitCode = await captureTestRun(config.repo, config.test_command, logPath);
    const afterRun = decideFromArtifact(artifact, verb, exitCode);
    if (!afterRun.ok) {
      console.error(afterRun.reason);
      return { code: afterRun.exitCode };
    }

    await setFields({
      type: "slice",
      vaultRoot,
      project,
      id,
      fields: verb === "red" ? { status: "red", red_log_ref: logPath } : { status: "green", green_log_ref: logPath },
    });
    console.log(logPath);
    console.error(`${verb} captured at ${logPath}`);
    await writePhaseDocToStderr(config.repo, verb === "red" ? "green" : "close", phaseDocOptions(parsed));
    return { code: 0 };
  } catch (error) {
    return handleSliceError(error);
  }
}

async function closeSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "review-verdict", "doc-phase"], [], ["no-doc"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  const verdict = stringValue(parsed.values, "review-verdict");
  if (id === undefined || project === undefined || verdict === undefined) {
    console.error("missing required field: id, project, review-verdict");
    return { code: 1 };
  }
  if (!reviewVerdicts.has(verdict)) {
    console.error("review-verdict must be one of: pass, pass-with-notes, reject");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "slice", vaultRoot, project, id });
    const decision = decideFromArtifact(artifact, "close");
    if (!decision.ok) {
      console.error(decision.reason);
      return { code: decision.exitCode };
    }
    await setFields({ type: "slice", vaultRoot, project, id, fields: { status: "closed", review_verdict: verdict } });
    console.error(`closed with verdict ${verdict}`);
    const config = await loadProjectConfig(join(vaultRoot, "projects", project));
    await writePhaseDocToStderr(config.repo, "handover", phaseDocOptions(parsed));
    return { code: 0 };
  } catch (error) {
    return handleSliceError(error);
  }
}

async function showSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "field"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  try {
    const artifact = await readArtifact({ type: "slice", vaultRoot, project, id });
    const field = stringValue(parsed.values, "field");
    if (field !== undefined) {
      const value = artifact.fields[field];
      process.stdout.write(`${formatFieldValue(value)}\n`);
      return { code: 0 };
    }
    process.stdout.write(artifact.body);
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

function decideFromArtifact(artifact: Artifact, verb: "red" | "green" | "close", capturedExitCode?: number) {
  return decideTransition({
    id: artifact.id,
    verb,
    status: artifact.fields.status,
    acceptance: artifact.fields.acceptance,
    todos: artifact.fields.todo,
    tddExempt: artifact.fields.tdd_exempt,
    tddExemptReason: artifact.fields.tdd_exempt_reason,
    capturedExitCode,
  });
}

async function captureTestRun(repo: string, command: string, logPath: string): Promise<number> {
  await mkdir(join(repo, ".wiki", "state", "slices"), { recursive: true });
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await writeFile(logPath, `${stdout}${stderr}`);
  return exitCode;
}

function handleSliceError(error: unknown): CliResult {
  if (error instanceof ArtifactNotFoundError || error instanceof ArtifactValidationError) {
    console.error(error.message);
    return { code: 1 };
  }
  if (error instanceof ProjectConfigError) {
    console.error(error.message);
    return { code: 10 };
  }
  throw error;
}

function parseFieldValue(field: string, raw: string): unknown {
  if (field === "tdd_exempt") {
    return raw === "true";
  }
  if (field === "todo") {
    const [id, text, done] = raw.split("|");
    if (id !== undefined && text !== undefined && done !== undefined) {
      return { id, text, done: done === "true" };
    }
  }
  return raw;
}

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("\n");
  }
  if (value === undefined) {
    return "";
  }
  return String(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
