import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type TemplateDeployResult = {
  deployed: string[];
  count: number;
};

/**
 * Copy all .md files from repoTemplatesDir to vaultTemplatesDir.
 * Always overwrites — templates are CLI-owned, not user-editable.
 */
export async function deployTemplates(
  repoTemplatesDir: string,
  vaultTemplatesDir: string,
): Promise<TemplateDeployResult> {
  const entries = await readdir(repoTemplatesDir);
  const mdFiles = entries.filter((f) => f.endsWith(".md"));

  await Promise.all(
    mdFiles.map((f) => copyFile(join(repoTemplatesDir, f), join(vaultTemplatesDir, f))),
  );

  return { deployed: mdFiles, count: mdFiles.length };
}
