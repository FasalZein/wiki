import { readdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import { openArtifact } from "./artifact-file";
import { projectPath } from "./paths";
import { type Structure } from "./registry";

/**
 * The per-invocation artifact-resolution read-cache (ADR-0045 item 5). ONE
 * recursive walk of the project's folders answers all three questions verbs ask
 * of the vault — "where is this id's file" ({@link IdIndex.resolve}), "what's the
 * highest id for this prefix" ({@link IdIndex.maxId}), "does this id exist"
 * ({@link IdIndex.has}) — instead of each rebuilding its own scan per call.
 *
 * It captures both spines the walk sees: the frontmatter-`id` -> path map (the
 * PRD-0013 id spine; >1 path = a duplicate doctor flags) and every `.md` path (so
 * filename-based max and the legacy filename-glob fallback need no second walk).
 *
 * READ cache only. Id ALLOCATION stays a fresh disk read inside `withProjectLock`
 * (SLICE-0121): {@link nextId} builds a fresh IdIndex each call so two sequential
 * (or cross-process, lock-serialized) creates always see each other's writes. A
 * threaded index used across a write is kept honest by {@link IdIndex.note}.
 */
export class IdIndex {
  private constructor(
    private readonly idToPaths: Map<string, string[]>,
    // ponytail: flat list, linear-scanned by resolve. Vault sections hold tens–
    // hundreds of files; index by directory if a vault ever makes this hot.
    private readonly files: string[],
  ) {}

  static async build(vaultRoot: string, project: string, structure: Structure): Promise<IdIndex> {
    const root = projectPath(vaultRoot, project);
    const idToPaths = new Map<string, string[]>();
    const files: string[] = [];
    // Folders are data in the structure; structure.folders already dedups shared folders.
    for (const folder of structure.folders) {
      await collect(join(root, folder), idToPaths, files);
    }
    return new IdIndex(idToPaths, files);
  }

  /** The raw frontmatter-`id` -> paths spine, for duplicate/link scans that want
   *  the whole map (doctor, links, mutate). */
  get idMap(): Map<string, string[]> {
    return this.idToPaths;
  }

  has(id: string): boolean {
    return this.idToPaths.has(id);
  }

  /**
   * Highest numeric suffix among the ids sharing `prefix` — across both the
   * frontmatter ids (the real spine: a date-named file whose id outranks every
   * filename must still bump the counter) and the filenames under `directory`.
   * `countAdrFormat` also counts bare `NNNN-*.md` legacy filenames (decisions).
   */
  maxId(prefix: string, directory: string, countAdrFormat: boolean): number {
    const prefixPattern = new RegExp(`^${prefix}-(\\d{3,})(?:-.+)?\\.md$`);
    const adrPattern = /^(\d{3,})-.+\.md$/;
    const idPattern = new RegExp(`^${prefix}-(\\d+)$`);
    let highest = 0;

    for (const path of this.files) {
      if (!path.startsWith(directory + sep)) continue;
      const name = basename(path);
      const prefixMatch = prefixPattern.exec(name);
      if (prefixMatch?.[1] !== undefined) {
        highest = Math.max(highest, Number.parseInt(prefixMatch[1], 10));
        continue;
      }
      if (countAdrFormat) {
        const adrMatch = adrPattern.exec(name);
        if (adrMatch?.[1] !== undefined) highest = Math.max(highest, Number.parseInt(adrMatch[1], 10));
      }
    }

    for (const id of this.idToPaths.keys()) {
      const match = idPattern.exec(id);
      if (match?.[1] !== undefined) highest = Math.max(highest, Number.parseInt(match[1], 10));
    }
    return highest;
  }

  /**
   * Resolve `id` to its file within `directory`, preserving SLICE-0077 precedence
   * exactly: frontmatter-id index (scoped to this directory so a shared id can't
   * pull in another kind's file) -> exact `ID.md` -> filename glob (`ID-slug.md`).
   * A branch section files into bucket subfolders so its glob is recursive; a leaf
   * holds files directly. Returns the (possibly non-existent) exact path as the
   * last resort, matching the pre-cache readFile-probe fallthrough.
   */
  resolve(id: string, directory: string, isBranch: boolean): string {
    const inDir = this.idToPaths.get(id)?.find((path) => path.startsWith(directory + sep) || dirname(path) === directory);
    if (inDir !== undefined) return inDir;

    const exact = join(directory, `${id}.md`);
    if (this.files.includes(exact)) return exact;

    const nameMatches = (name: string) => name === `${id}.md` || (name.startsWith(`${id}-`) && name.endsWith(".md"));
    const match = this.files.find((path) =>
      isBranch ? path.startsWith(directory + sep) && nameMatches(basename(path)) : dirname(path) === directory && nameMatches(basename(path)),
    );
    return match ?? exact;
  }

  /**
   * Update-on-write (ADR-0045 invalidation discipline): record a freshly written
   * file so a later {@link resolve}/{@link has} in the SAME invocation sees it. A
   * threaded read-cache would otherwise be stale for artifacts this process just
   * created. Allocation does NOT rely on this (it re-reads disk under the lock).
   */
  note(id: string, path: string): void {
    if (!this.files.includes(path)) this.files.push(path);
    const paths = this.idToPaths.get(id);
    if (paths === undefined) this.idToPaths.set(id, [path]);
    else if (!paths.includes(path)) paths.push(path);
  }
}

/**
 * The frontmatter-`id` -> absolute-path index for one project — the map form used
 * by duplicate detection, link validation, and the capture idempotency check. A
 * thin wrapper over {@link IdIndex.build} so the walk has one implementation.
 */
export async function buildIdIndex(vaultRoot: string, project: string, structure: Structure): Promise<Map<string, string[]>> {
  return (await IdIndex.build(vaultRoot, project, structure)).idMap;
}

async function collect(directory: string, idToPaths: Map<string, string[]>, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // folder may not exist yet — nothing to index
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(full, idToPaths, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
      const id = await readFrontmatterId(full);
      if (id === undefined) continue;
      const paths = idToPaths.get(id);
      if (paths === undefined) idToPaths.set(id, [full]);
      else paths.push(full);
    }
  }
}

async function readFrontmatterId(path: string): Promise<string | undefined> {
  let id: string | undefined;
  try {
    id = (await openArtifact(path)).field("id");
  } catch {
    return undefined;
  }
  return id !== undefined && id.length > 0 ? id : undefined;
}
