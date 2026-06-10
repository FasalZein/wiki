import { join } from "node:path";

import { embedCollection, ensureCollection, QmdError, updateCollection } from "../../integrations/qmd";
import { assertProjectStructure, loadProjectConfig } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { checkProjectDocsStructure } from "../../bootstrap/doctor";
import { booleanValue, parseCommand } from "../parse";
import { resolveProject } from "../resolve-project";
import type { CliResult } from "../dispatch";

export async function handleSync(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["include-research", "pull", "force-embed"]);
  const project = await resolveProject(parsed);
  if (project === undefined) {
    console.error("missing required field: project (pass --project or start a session with wiki session start)");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);

  // Gate: don't embed a project whose docs/ violates the locked-category invariant
  // (ADR-0028). sync is the natural chokepoint — catch rogue folders / loose docs here
  // before they get indexed, and point the user at the fix. Same check `wiki doctor` runs.
  const docsIssues = await checkProjectDocsStructure(vaultRoot, project);
  if (docsIssues.length > 0) {
    for (const issue of docsIssues) console.error(issue.message);
    console.error(`refusing to sync: fix the ${docsIssues.length} docs-structure issue(s) above, then retry.`);
    return { code: 1 };
  }

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
