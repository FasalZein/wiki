#!/usr/bin/env bun
// One-off forge-shell body migration (PRD-0023 vault reconciliation).
// Re-renders pure `## Source` migration shells to their flat template, reusing
// the tool's own render primitives. Machine-owned sections render from the
// file's existing frontmatter; the lost authored section(s) get an HONEST
// placeholder noting the forge->vault migration loss. No tool change.
//
// Usage:
//   bun scripts/migrate-forge-shells.ts            # dry-run, prints proposed output for samples
//   bun scripts/migrate-forge-shells.ts --write    # rewrite all shells in place
//   bun scripts/migrate-forge-shells.ts --project rajanaya --write
import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { Glob } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";

import { resolveTemplatePath, loadTemplate, normalizeInlineMaps } from "../src/schema/load";
import { authoredSections } from "../src/artifacts/body";
import { renderArtifact } from "../src/artifacts/render";

const VAULT = process.env.KNOWLEDGE_VAULT_ROOT ?? join(homedir(), "Knowledge");
const WRITE = process.argv.includes("--write");
const projIdx = process.argv.indexOf("--project");
const ONLY_PROJECT = projIdx !== -1 ? process.argv[projIdx + 1] : undefined;

const LOSS_NOTE =
  "_Build spec not preserved in the forge→vault migration. See the summary above and the acceptance criteria below; recover detail from git history or the live repo if needed._";

const KIND_BY_PREFIX: Record<string, string> = { SLICE: "slice", PRD: "prd" };

/** A shell = exactly one H2 and it is `## Source`. */
function isForgeShell(body: string): boolean {
  const h2 = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  return h2.length === 1 && h2[0] === "Source";
}

async function main() {
  const glob = new Glob("projects/*/**/*.md");
  let scanned = 0;
  let migrated = 0;
  const samples: string[] = [];
  const seenKinds = new Set<string>();

  for await (const rel of glob.scan(VAULT)) {
    if (rel.endsWith("/index.md") || rel.endsWith("/_project.md")) continue;
    const proj = rel.split("/")[1];
    if (ONLY_PROJECT && proj !== ONLY_PROJECT) continue;

    const abs = join(VAULT, rel);
    const raw = await readFile(abs, "utf-8");
    const parsed = matter(raw);
    if (!isForgeShell(parsed.content)) continue;

    const id = typeof parsed.data.id === "string" ? parsed.data.id : "";
    const prefix = id.split("-")[0];
    const kind = KIND_BY_PREFIX[prefix];
    if (!kind) {
      console.warn(`SKIP (unknown kind): ${rel}  id=${id || "(none)"}`);
      continue;
    }
    scanned++;

    const templateText = await readFile(resolveTemplatePath(`${kind}.md`), "utf-8");
    const schema = await loadTemplate(kind);
    const schemaFields = new Set(schema.fields.map((f) => f.name));
    const templateBody = matter(normalizeInlineMaps(templateText)).content;
    const authored = authoredSections(templateBody, schemaFields);

    // Every authored (forge-lost) section gets the honest placeholder.
    const bodySections: Record<string, string> = {};
    for (const s of authored) bodySections[s.placeholder] = LOSS_NOTE;

    const content = renderArtifact(templateText, parsed.data as any, bodySections);

    if (WRITE) {
      await writeFile(abs, content, "utf-8");
      migrated++;
    } else {
      migrated++;
      if (!seenKinds.has(kind)) {
        seenKinds.add(kind);
        samples.push(`\n===== DRY-RUN SAMPLE (${kind}) ${rel} =====\n${content}`);
      }
    }
  }

  if (!WRITE) for (const s of samples) console.log(s);
  console.log(
    `\n${WRITE ? "MIGRATED" : "WOULD MIGRATE"} ${migrated} forge-shell file(s)` +
      `${ONLY_PROJECT ? ` in ${ONLY_PROJECT}` : " vault-wide"}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
