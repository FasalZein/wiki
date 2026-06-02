import { join } from "node:path";

import { embedCollection, ensureCollection, QmdError, updateCollection } from "../../integrations/qmd";
import { assertProjectStructure, loadProjectConfig } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { booleanValue, parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleSync(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["include-research", "pull", "force-embed"]);
  const project = stringValue(parsed.values, "project");
  if (project === undefined) {
    console.error("missing required field: project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  try {
    await assertProjectStructure(projectPath);
    const config = await loadProjectConfig(projectPath);
    const qmdCommand = process.env.QMD_COMMAND ?? config.qmd_command;
    const targets = [{ name: project, path: projectPath }];
    if (booleanValue(parsed.values, "include-research")) {
      targets.push({ name: "research", path: config.research_path });
    }

    for (const target of targets) {
      await ensureCollection(qmdCommand, target.name, target.path);
      await updateCollection(qmdCommand, target.name, booleanValue(parsed.values, "pull"));
      await embedCollection(qmdCommand, target.name, booleanValue(parsed.values, "force-embed"));
      console.error(`synced collection ${target.name}`);
    }
    return { code: 0 };
  } catch (error) {
    if (error instanceof QmdError) {
      console.error(error.summary);
      return { code: 10 };
    }
    throw error;
  }
}
