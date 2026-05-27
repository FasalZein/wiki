import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decideTransition } from "../../artifacts/transitions";
import { ArtifactNotFoundError, ArtifactValidationError, readArtifact, setFields, type Artifact } from "../../artifacts/store";
import { loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";
import { phaseDocOptions, writePhaseDocToStderr } from "../phase-docs";

type TddVerb = "red" | "green";

const tddConfig = {
  red: { logSuffix: "red", statusField: "red_log_ref", nextPhase: "green" },
  green: { logSuffix: "green", statusField: "green_log_ref", nextPhase: "close" },
} as const;

export async function handleRed(args: string[]): Promise<CliResult> {
  return handleTdd("red", args);
}

export async function handleGreen(args: string[]): Promise<CliResult> {
  return handleTdd("green", args);
}

async function handleTdd(verb: TddVerb, args: string[]): Promise<CliResult> {
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
    const { logSuffix, statusField, nextPhase } = tddConfig[verb];
    const logPath = join(config.repo, ".wiki", "state", "slices", `${id}-${logSuffix}.log`);
    const exitCode = await captureTestRun(config.repo, config.test_command, logPath);
    const afterRun = decideFromArtifact(artifact, verb, exitCode);
    if (!afterRun.ok) {
      console.error(afterRun.reason);
      return { code: afterRun.exitCode };
    }

    await setFields({ type: "slice", vaultRoot, project, id, fields: { status: verb, [statusField]: logPath } });
    console.log(logPath);
    console.error(`${verb} captured at ${logPath}`);
    await writePhaseDocToStderr(config.repo, nextPhase, phaseDocOptions(parsed));
    return { code: 0 };
  } catch (error) {
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
}

function decideFromArtifact(artifact: Artifact, verb: TddVerb, capturedExitCode?: number) {
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
  const proc = Bun.spawn(["bash", "-lc", command], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await writeFile(logPath, `${stdout}${stderr}`);
  return exitCode;
}
