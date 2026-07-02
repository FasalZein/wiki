import type { TemplateType } from "../schema/load";
import { IdIndex } from "./id-index";
import { artifactDirectory } from "./paths";
import { type Structure } from "./registry";

/**
 * Allocate the next free id for a type. A single {@link IdIndex} walk answers both
 * halves of "what's the highest existing id": the filename ids under the section
 * folder AND the frontmatter ids sharing the prefix (a date-named or id-only file
 * whose frontmatter id outranks every filename must still bump the counter, or
 * create re-mints a colliding id).
 *
 * SLICE-0111: id allocation keys on the SECTION, not the kind — a branch section's
 * bucket subfolders all share the section prefix and id-space, so {@link IdIndex.maxId}
 * scans the section folder recursively; a leaf section has no subfolders, so a
 * recursive scan equals a flat read.
 *
 * SLICE-0121: this builds a FRESH index every call (a re-read, not a threaded
 * cache) so it always reflects prior writes — two sequential creates in one
 * process, and cross-process creates serialized by `withProjectLock`, each see the
 * other's file and mint distinct ids.
 */
export async function nextId(type: TemplateType, vaultRoot: string, project: string, structure: Structure): Promise<string> {
  const prefix = structure.specFor(type).prefix;
  const directory = artifactDirectory(type, vaultRoot, project, structure);
  const index = await IdIndex.build(vaultRoot, project, structure);
  const highest = index.maxId(prefix, directory, type === "decision");
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}
