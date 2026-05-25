import { join } from "node:path";

import { createArtifact } from "../../artifacts/store";
import { assertProjectStructure } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleDecision(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createDecision(rest);
  }
  console.error(`unknown decision subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function createDecision(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "context", "decision", "consequences", "project"]);
  const project = stringValue(parsed.values, "project");
  const title = stringValue(parsed.values, "title");
  const context = stringValue(parsed.values, "context");
  const decision = stringValue(parsed.values, "decision");
  const consequences = stringValue(parsed.values, "consequences");
  if (project === undefined || title === undefined || context === undefined || decision === undefined || consequences === undefined) {
    console.error("missing required field");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  await assertProjectStructure(join(vaultRoot, "projects", project));
  const artifact = await createArtifact({
    type: "decision",
    vaultRoot,
    project,
    fields: { title, context, decision, consequences },
  });
  console.log(artifact.id);
  console.error(`created ${artifact.id}`);
  return { code: 0 };
}
