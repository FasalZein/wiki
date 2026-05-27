import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decideTransition } from "../../artifacts/transitions";
import { ArtifactNotFoundError, ArtifactValidationError, readArtifact, setFields, type Artifact } from "../../artifacts/store";
import { loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";
import { phaseDocOptions, writePhaseDocToStderr } from "../phase-docs";

export async function handleRed(args: string[]): Promise<CliResult> {
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
    const beforeRun = decideFromArtifact(artifact, "red");
    if (!beforeRun.ok) {
      console.error(beforeRun.reason);
      return { code: beforeRun.exitCode };
    }

    const config = await loadProjectConfig(join(vaultRoot, "projects", project), { requireLifecycle: true });
    const logPath = join(config.repo, ".wiki", "state", "slices", `${id}-red.log`);
    const exitCode = await captureTestRun(config.repo, config.test_command, logPath);
    const afterRun = decideFromArtifact(artifact, "red", exitCode);
    if (!afterRun.ok) {
      console.error(afterRun.reason);
      return { code: afterRun.exitCode };
    }

    await setFields({ type: "slice", vaultRoot, project, id, fields: { status: "red", red_log_ref: logPath } });
    console.log(logPath);
    console.error(`red captured at ${logPath}`);
    await writePhaseDocToStderr(config.repo, "green", phaseDocOptions(parsed));
    return { code: 0 };
  } catch (error) {
    return handleSliceError(error);
  }
}

function decideFromArtifact(artifact: Artifact, verb: "red", capturedExitCode?: number) {
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
