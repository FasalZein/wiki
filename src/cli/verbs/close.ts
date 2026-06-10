import { decideTransition, parseBodyTodos } from "../../artifacts/transitions";
import { ArtifactNotFoundError, ArtifactValidationError, readArtifact, setFields, type Artifact } from "../../artifacts/store";
import { ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue } from "../parse";
import { phaseDocOptions, writePhaseDocToStderr } from "../phase-docs";

const reviewVerdicts = new Set(["pass", "pass-with-notes", "reject"]);

export async function handleClose(args: string[]): Promise<CliResult> {
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
    const decision = decideFromArtifact(artifact);
    if (!decision.ok) {
      console.error(decision.reason);
      return { code: decision.exitCode };
    }
    await setFields({ type: "slice", vaultRoot, project, id, fields: { status: "closed", review_verdict: verdict } });
    console.error(`closed with verdict ${verdict}`);
    await writePhaseDocToStderr("handover", phaseDocOptions(parsed));
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

function decideFromArtifact(artifact: Artifact) {
  // The close gate sees both todo homes: a frontmatter todo list and the body's
  // "## Todo" checkboxes that template-created slices carry.
  const fieldTodos = Array.isArray(artifact.fields.todo) ? artifact.fields.todo : [];
  return decideTransition({
    id: artifact.id,
    verb: "close",
    status: artifact.fields.status,
    acceptance: artifact.fields.acceptance,
    todos: [...fieldTodos, ...parseBodyTodos(artifact.body)],
    tddExempt: artifact.fields.tdd_exempt,
    tddExemptReason: artifact.fields.tdd_exempt_reason,
  });
}
