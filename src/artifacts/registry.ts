import type { TemplateType } from "../schema/load";

export interface ArtifactSpec {
  /** ID prefix, e.g. "DOC" yields DOC-0001. */
  prefix: string;
  /** Per-project folder the artifact lives in, e.g. "docs". */
  folder: string;
  /** Whether `wiki create` runs the advisory dedup gate for this type. */
  dedup: boolean;
}

/**
 * The single source of truth for artifact types. Every per-type fact (ID
 * prefix, folder, dedup eligibility) lives here so adding a type is one entry,
 * not a hunt across id/paths/validate/project/dedup/search.
 */
export const ARTIFACTS: Record<TemplateType, ArtifactSpec> = {
  prd: { prefix: "PRD", folder: "prds", dedup: true },
  slice: { prefix: "SLICE", folder: "slices", dedup: true },
  decision: { prefix: "ADR", folder: "adrs", dedup: true },
  handover: { prefix: "HANDOVER", folder: "handovers", dedup: false },
  doc: { prefix: "DOC", folder: "docs", dedup: true },
};

/** Folders that hold CLI-managed artifacts; required by assertProjectStructure. */
export const ARTIFACT_FOLDERS: readonly string[] = Object.values(ARTIFACTS).map((spec) => spec.folder);

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

/** Named non-artifact folders scaffolded at init. */
export const STRUCTURAL_FOLDERS: readonly string[] = [];

/** Reverse map (folder name -> artifact type) for path-based type inference. */
export const FOLDER_TO_TYPE: Readonly<Record<string, TemplateType>> = Object.fromEntries(
  (Object.entries(ARTIFACTS) as [TemplateType, ArtifactSpec][]).map(([type, spec]) => [spec.folder, type]),
);

/** Reverse map (id prefix -> artifact type) for id-based type inference. */
export const PREFIX_TO_TYPE: Readonly<Record<string, TemplateType>> = Object.fromEntries(
  (Object.entries(ARTIFACTS) as [TemplateType, ArtifactSpec][]).map(([type, spec]) => [spec.prefix, type]),
);

/** Infer the artifact type from an id like "SLICE-0032" (prefix before the dash). */
export function typeForId(id: string): TemplateType | undefined {
  const prefix = id.split("-")[0]?.toUpperCase();
  return prefix === undefined ? undefined : PREFIX_TO_TYPE[prefix];
}
