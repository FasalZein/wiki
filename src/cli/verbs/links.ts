/**
 * `wiki links <id>` (PRD-0013 item 7) — a pure vault read of the artifact graph.
 * Prints outbound links (frontmatter link fields + body `[[..]]` wikilinks) and
 * inbound backlinks (other artifacts in the project that reference this id),
 * both scanned via the frontmatter-id index. No qmd, no embedding — just files.
 */

import { buildIdIndex } from "../../artifacts/id-index";
import { bareIdOf, collectReferences, inboundReferences, isLocalIdRef } from "../../artifacts/references";
import { typeForId } from "../../artifacts/registry";
import { getVaultRoot } from "../../config/vault";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand } from "../parse";
import { resolveProject } from "../resolve-project";

export async function handleLinks(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const id = parsed.positionals[0];
  if (id === undefined) return fail("usage: wiki links <id> [--project <name>]");
  if (typeForId(id) === undefined) return fail(`cannot infer artifact type from id: ${id}`);

  const project = await resolveProject(parsed);
  if (project === undefined) return fail("no project: pass --project <name> or run from a linked repo");
  const vaultRoot = await getVaultRoot();

  const index = await buildIdIndex(vaultRoot, project);
  const ownPaths = index.get(id);
  if (ownPaths === undefined) return fail(`artifact not found: ${id}`);

  // Outbound: every local id this artifact references, deduped and sorted.
  const outbound = new Set<string>();
  for (const path of ownPaths) {
    for (const ref of await collectReferences(path)) {
      const refId = bareIdOf(ref);
      if (refId !== undefined && refId !== id && isLocalIdRef(refId)) outbound.add(refId);
    }
  }

  // Inbound: every other artifact whose references include this id.
  const inbound = await inboundReferences(index, id);

  const result = { id, outbound: [...outbound].sort(), inbound };
  if (jsonEnabled()) {
    emitJson(result);
  } else {
    const fmt = (ids: string[]) => (ids.length === 0 ? "(none)" : ids.join(", "));
    console.log(`${id}`);
    console.log(`  outbound: ${fmt(result.outbound)}`);
    console.log(`  inbound:  ${fmt(result.inbound)}`);
  }
  return { code: 0 };
}

function fail(message: string): CliResult {
  if (jsonEnabled()) emitJsonError({ error: message });
  else console.error(message);
  return { code: 1 };
}
