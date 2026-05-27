import { join } from "node:path";

import { loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { readSession } from "../../state/session";
import { loadPhaseDoc, phaseDocPath } from "../phase-docs";
import type { CliResult } from "../dispatch";
import { booleanValue, parseCommand, stringValue } from "../parse";

export async function handleStatus(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["with-doc"]);
  const project = stringValue(parsed.values, "project");
  let repo: string;
  if (project === undefined) {
    repo = process.cwd();
  } else {
    const vaultRoot = await getVaultRoot();
    try {
      repo = (await loadProjectConfig(join(vaultRoot, "projects", project))).repo;
    } catch (error) {
      if (error instanceof ProjectConfigError) {
        console.error(error.message);
        return { code: 10 };
      }
      throw error;
    }
  }
  const session = await readSession(repo);
  if (session === null) {
    const label = project === undefined ? "current repo" : `project ${project}`;
    console.log(`No active session for ${label}. Run wiki session start --project <project>.`);
    return { code: 0 };
  }

  console.log(`Project: ${session.project}`);
  console.log(`Phase: ${session.phase}`);
  console.log(`Active PRD: ${session.active_prd ?? "(none)"}`);
  console.log(`Active slices: ${session.active_slices.length > 0 ? session.active_slices.join(", ") : "(none)"}`);
  console.log(`Next: ${nextAction(session.project, session.phase, session.active_slices[0])}`);

  if (booleanValue(parsed.values, "with-doc")) {
    const doc = await loadPhaseDoc(repo, session.phase);
    if (doc === null) {
      console.error(`phase doc not found: ${phaseDocPath(repo, session.phase)}`);
      return { code: 0 };
    }
    console.log(`--- phase doc: ${session.phase} ---`);
    process.stdout.write(doc.endsWith("\n") ? doc : `${doc}\n`);
  }
  return { code: 0 };
}

function nextAction(project: string, phase: string, activeSlice: string | undefined): string {
  const slice = activeSlice ?? "<slice>";
  if (phase === "plan") return "run wiki create prd ...";
  if (phase === "prd") return "run wiki create slice ...";
  if (phase === "slice") return `run wiki red ${slice} --project ${project}`;
  if (phase === "red") return `write implementation, then run wiki green ${slice} --project ${project}`;
  if (phase === "green" || phase === "review" || phase === "close") {
    return `run wiki close ${slice} --project ${project} --review-verdict pass`;
  }
  if (phase === "handover") return "run wiki handover ...";
  return "no enforced next step";
}
