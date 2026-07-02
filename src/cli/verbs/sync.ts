import { projectPath } from "../../artifacts/paths";
import { writeProjectIndex, writeVaultIndex } from "../../artifacts/index-md";
import { embedCollection, ensureCollection, QmdError, updateCollection } from "../../integrations/qmd";
import { resolveQmdCommand } from "../../integrations/project-index";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { loadStructure } from "../../artifacts/registry";
import { checkProjectDocsStructure } from "../../bootstrap/doctor";
import { booleanValue, parseCommand } from "../parse";
import { resolveProject } from "../resolve-project";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";

export async function handleSync(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["pull", "force-embed"]);
  const project = await resolveProject(parsed);
  if (project === undefined) {
    console.error("missing required field: project (pass --project or link the repo with wiki project link)");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  const projPath = projectPath(vaultRoot, project);
  try {
    await loadProjectConfig(projPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(await projectErrorMessage(vaultRoot, project));
      return { code: 10 };
    }
    throw error;
  }

  // Gate: don't embed a project whose folders violate the config structure tree
  // (ADR-0028's no-loose-files invariant, now config-declared per PRD-0019). sync is the
  // natural chokepoint — catch rogue folders / loose docs here before they get indexed,
  // and point the user at the fix. Same check `wiki doctor` runs.
  const docsIssues = await checkProjectDocsStructure(vaultRoot, project, structure);
  if (docsIssues.length > 0) {
    for (const issue of docsIssues) console.error(issue.message);
    console.error(`refusing to sync: fix the ${docsIssues.length} docs-structure issue(s) above, then retry.`);
    return { code: 1 };
  }

  try {
    await assertProjectStructure(projPath, structure);
    const config = await loadProjectConfig(projPath);
    const qmdCommand = resolveQmdCommand(config);
    const targets = [{ name: project, path: projPath }];

    for (const target of targets) {
      await ensureCollection(qmdCommand, target.name, target.path);
      await updateCollection(qmdCommand, target.name, booleanValue(parsed.values, "pull"));
      await embedCollection(qmdCommand, target.name, booleanValue(parsed.values, "force-embed"));
      if (!jsonEnabled()) console.error(`synced collection ${target.name}`);
    }
    await writeProjectIndex(vaultRoot, project, structure);
    await writeVaultIndex(vaultRoot);
    if (jsonEnabled()) emitJson({ project, synced: targets.map((t) => t.name) });
    return { code: 0 };
  } catch (error) {
    if (error instanceof QmdError) {
      if (jsonEnabled()) emitJsonError({ error: error.summary });
      else console.error(error.summary);
      return { code: 10 };
    }
    throw error;
  }
}
