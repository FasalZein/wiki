import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TemplateType } from "../schema/load";
import { isFileNotFound } from "../util";
import wikiConfig from "../../wiki.json";

export interface ArtifactSpec {
  /** ID prefix, e.g. "DOC" yields DOC-0001. */
  prefix: string;
  /** Per-project folder the artifact lives in, e.g. "docs". */
  folder: string;
  /** Whether `wiki create` runs the advisory dedup gate for this type. */
  dedup: boolean;
  /** Skill that authors this kind, if any; read by per-runtime hooks to route output. */
  skill?: string;
}

/**
 * A resolved set of artifact kinds plus the lookups derived from them. One
 * `Structure` is loaded per CLI invocation (from the vault, falling back to the
 * bundled default) and threaded synchronously to consumers — there is no async
 * in the lookups and no module-global mutable cache. PRD-0021 introduces this as
 * the single seam; the later section/bucket model (PRD-0019) extends it.
 */
export interface Structure {
  readonly kinds: Readonly<Record<TemplateType, ArtifactSpec>>;
  readonly folders: readonly string[];
  /** A kind's spec, failing loudly on an unknown kind. */
  specFor(type: TemplateType): ArtifactSpec;
  /** Infer the artifact type from an id like "SLICE-0032" (prefix before the dash). */
  typeForId(id: string): TemplateType | undefined;
  /** Infer the artifact type from a vault-relative `projects/<p>/<folder>/<file>.md` path. */
  artifactTypeForVaultPath(rel: string): TemplateType | undefined;
  /** Map an authoring skill to the kind it produces (only kinds with a `skill`). */
  kindForSkill(skill: string): TemplateType | undefined;
}

/**
 * Artifact kinds are data, defined in wiki.json — not hardcoded here, so a skill
 * can extend the vault with a kind entry + a templates/<kind>.md, no code change.
 * Parsed (not trusted) so a malformed config fails loudly, not silently.
 */
function parseKinds(raw: unknown): Record<TemplateType, ArtifactSpec> {
  if (raw === null || typeof raw !== "object") {
    throw new Error("wiki.json: missing 'kinds' object");
  }
  const kinds: Record<string, ArtifactSpec> = {};
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (spec === null || typeof spec !== "object") {
      throw new Error(`wiki.json: kind '${name}' must be an object`);
    }
    const s = spec as Record<string, unknown>;
    if (typeof s.prefix !== "string" || typeof s.folder !== "string" || typeof s.dedup !== "boolean") {
      throw new Error(`wiki.json: kind '${name}' needs a string prefix, string folder, and boolean dedup`);
    }
    kinds[name] = {
      prefix: s.prefix,
      folder: s.folder,
      dedup: s.dedup,
      ...(typeof s.skill === "string" ? { skill: s.skill } : {}),
    };
  }
  return kinds;
}

/** Build a Structure from a parsed kinds map: precompute the reverse maps once,
 *  then expose them through the lookup methods. Pure — no I/O, no shared state. */
function buildStructure(kinds: Record<TemplateType, ArtifactSpec>): Structure {
  const entries = Object.entries(kinds) as [TemplateType, ArtifactSpec][];
  const prefixToType = new Map(entries.map(([type, spec]) => [spec.prefix, type]));
  const folderToType = new Map(entries.map(([type, spec]) => [spec.folder, type]));
  const skillToKind = new Map(
    entries.filter(([, spec]) => spec.skill !== undefined).map(([type, spec]) => [spec.skill as string, type]),
  );
  const folders = [...new Set(entries.map(([, spec]) => spec.folder))];
  return {
    kinds,
    folders,
    specFor(type) {
      const spec = kinds[type];
      if (spec === undefined) {
        throw new Error(`unknown artifact kind: ${type} (not defined in wiki.json)`);
      }
      return spec;
    },
    typeForId(id) {
      const prefix = id.split("-")[0]?.toUpperCase();
      return prefix === undefined ? undefined : prefixToType.get(prefix);
    },
    artifactTypeForVaultPath(rel) {
      const parts = rel.split("/");
      const folder = parts[2];
      if (parts[0] !== "projects" || parts.length < 4 || folder === undefined) {
        return undefined;
      }
      return folderToType.get(folder);
    },
    kindForSkill(skill) {
      return skillToKind.get(skill);
    },
  };
}

/** The bundled default structure (today's five kinds), used when a vault has no
 *  wiki.json of its own. */
export const DEFAULT_STRUCTURE: Structure = buildStructure(parseKinds(wikiConfig.kinds));

/**
 * Load the structure for a vault: read `<vaultRoot>/wiki.json` at runtime and
 * build a Structure from it, falling back to the bundled default when the vault
 * has no config file. A malformed config throws loudly (parsed, not trusted),
 * writing nothing. Returns a plain synchronous Structure — callers thread it,
 * the lookups never await.
 */
export async function loadStructure(vaultRoot: string): Promise<Structure> {
  let content: string;
  try {
    content = await readFile(join(vaultRoot, "wiki.json"), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return DEFAULT_STRUCTURE;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`wiki.json: invalid JSON — ${(error as Error).message}`);
  }
  return buildStructure(parseKinds((parsed as { kinds?: unknown }).kinds));
}

/**
 * The single source of truth for artifact types, built from wiki.json. Every
 * per-type fact (ID prefix, folder, dedup eligibility, authoring skill) lives in
 * one entry, not a hunt across id/paths/validate/project/dedup/search.
 */
export const ARTIFACTS: Readonly<Record<TemplateType, ArtifactSpec>> = DEFAULT_STRUCTURE.kinds;

/** Look up a kind's spec, failing loudly on an unknown kind (the runtime check
 *  that replaces the old compile-time union). */
export function specFor(type: TemplateType): ArtifactSpec {
  return DEFAULT_STRUCTURE.specFor(type);
}

/** Folders that hold CLI-managed artifacts; required by assertProjectStructure. */
export const ARTIFACT_FOLDERS: readonly string[] = DEFAULT_STRUCTURE.folders;

/**
 * Locked vocabulary of doc category subfolders. Docs live in docs/<category>/.
 * Agents cannot invent new categories; every doc maps into exactly one of these.
 */
export const DOC_CATEGORIES = ["architecture", "research", "runbooks", "specs", "notes", "legacy"] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export function isDocCategory(value: string): value is DocCategory {
  return (DOC_CATEGORIES as readonly string[]).includes(value);
}

/** Default doc category derived from the doc's `type` enum when none is given.
 *  Unmapped types fall to `notes` — the intended catch-all — not `specs`, so `specs`
 *  stays "specifications" rather than an accidental junk drawer (ADR-0028). */
export function defaultCategoryForDocType(docType: string | undefined): DocCategory {
  switch (docType) {
    case "runbook":
      return "runbooks";
    case "research":
      return "research";
    default:
      return "notes";
  }
}

/** Reverse map (folder name -> artifact type) for path-based type inference. */
export const FOLDER_TO_TYPE: Readonly<Record<string, TemplateType>> = Object.fromEntries(
  (Object.entries(ARTIFACTS) as [TemplateType, ArtifactSpec][]).map(([type, spec]) => [spec.folder, type]),
);

/** Reverse map (authoring skill -> artifact kind) read by per-runtime hooks to
 *  route a skill's output into the vault. Only kinds with a `skill` appear. */
export const SKILL_TO_KIND: Readonly<Record<string, TemplateType>> = Object.fromEntries(
  (Object.entries(ARTIFACTS) as [TemplateType, ArtifactSpec][])
    .filter(([, spec]) => spec.skill !== undefined)
    .map(([type, spec]) => [spec.skill as string, type]),
);

/** Reverse map (id prefix -> artifact type) for id-based type inference. */
export const PREFIX_TO_TYPE: Readonly<Record<string, TemplateType>> = Object.fromEntries(
  (Object.entries(ARTIFACTS) as [TemplateType, ArtifactSpec][]).map(([type, spec]) => [spec.prefix, type]),
);

/** Infer the artifact type from an id like "SLICE-0032" (prefix before the dash). */
export function typeForId(id: string): TemplateType | undefined {
  return DEFAULT_STRUCTURE.typeForId(id);
}

/** Infer the artifact type from a vault-relative path. The convention is
 *  `projects/<project>/<folder>/<file>.md`, so the type comes from the folder
 *  segment (index 2). Returns undefined for paths outside that layout. */
export function artifactTypeForVaultPath(rel: string): TemplateType | undefined {
  return DEFAULT_STRUCTURE.artifactTypeForVaultPath(rel);
}
