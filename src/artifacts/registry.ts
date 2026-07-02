import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TemplateType } from "../schema/load";
import { isFileNotFound } from "../util";

export interface ArtifactSpec {
  /** ID prefix, e.g. "DOC" yields DOC-0001. */
  prefix: string;
  /** Per-project folder the artifact lives in, e.g. "docs". */
  folder: string;
  /** Whether `wiki create` runs the advisory dedup gate for this type. */
  dedup: boolean;
  /** Skill(s) that author this kind, if any; read by per-runtime hooks to route output.
   *  A string or a list — several skills may produce the same kind. */
  skill?: string | readonly string[];
  /** What-goes-where signal for a leaf kind (ADR-0044); surfaced by `wiki schema`
   *  and `wiki create <kind> --help`. Branch kinds carry criteria per bucket instead. */
  criteria?: string;
  /** Parent kind this child backlinks to (SLICE-0114). On create, the child's id
   *  is appended to the parent's `child_list` field. The parent id is read from
   *  the child's `parent_<parent>` field (e.g. parent: "prd" -> field parent_prd). */
  parent?: TemplateType;
  /** List field on THIS kind that receives child ids when a child declares it as
   *  `parent` (e.g. prd's "slices"). Generic backlink target (SLICE-0114). */
  child_list?: string;
}

/**
 * A leaf inside the section/bucket tree (PRD-0019). A bucket owns a body
 * template and a `criteria` string (the agent's what-goes-where signal) and
 * files into `folder`, sharing its section's id prefix and id-space. A LEAF
 * section has exactly one bucket (named after the section, filing into the
 * section folder); a BRANCH section has two or more named buckets, each filing
 * into a subfolder.
 */
export interface BucketSpec {
  /** Create-name; unique across the whole tree (validated at load). */
  readonly name: string;
  /** Project-relative folder the artifact files into, e.g. "prds" or "docs/architecture". */
  readonly folder: string;
  /** Body template (templates/<template>.md) this bucket applies. */
  readonly template: TemplateType;
  /** What-goes-where signal for the authoring agent; surfaced by later slices. */
  readonly criteria?: string;
}

/**
 * A top-level section of the tree (PRD-0019): a folder owning an id prefix and a
 * single shared id-space. A section is a BRANCH (holds buckets, no artifacts
 * directly) XOR a LEAF (one self-named bucket holding artifacts directly).
 * `buckets` is always non-empty.
 */
export interface SectionSpec {
  /** Section (kind) name, e.g. "doc". */
  readonly name: TemplateType;
  /** Shared id prefix for every bucket in this section. */
  readonly prefix: string;
  /** Top-level section folder, e.g. "docs". */
  readonly folder: string;
  readonly dedup: boolean;
  readonly skill?: string | readonly string[];
  readonly tree: "leaf" | "branch";
  readonly buckets: readonly BucketSpec[];
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
  /** The section/bucket tree (PRD-0019), one section per kind. */
  readonly sections: readonly SectionSpec[];
  /** A kind's spec, failing loudly on an unknown kind. */
  specFor(type: TemplateType): ArtifactSpec;
  /** Infer the artifact type from an id like "SLICE-0032" (prefix before the dash). */
  typeForId(id: string): TemplateType | undefined;
  /** Infer the artifact type from a vault-relative `projects/<p>/<folder>/<file>.md` path. */
  artifactTypeForVaultPath(rel: string): TemplateType | undefined;
  /** Map an authoring skill to the kind it produces (only kinds with a `skill`). */
  kindForSkill(skill: string): TemplateType | undefined;
  /** Resolve a create-name (a leaf or a branch bucket) to its section + bucket. */
  bucketFor(name: string): { section: SectionSpec; bucket: BucketSpec } | undefined;
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
    if (s.parent !== undefined && typeof s.parent !== "string") {
      throw new Error(`wiki.json: kind '${name}' field 'parent' must be a string`);
    }
    if (s.child_list !== undefined && typeof s.child_list !== "string") {
      throw new Error(`wiki.json: kind '${name}' field 'child_list' must be a string`);
    }
    if (s.criteria !== undefined && typeof s.criteria !== "string") {
      throw new Error(`wiki.json: kind '${name}' field 'criteria' must be a string`);
    }
    const skillOk =
      s.skill === undefined ||
      typeof s.skill === "string" ||
      (Array.isArray(s.skill) && s.skill.every((v) => typeof v === "string"));
    if (!skillOk) {
      throw new Error(`wiki.json: kind '${name}' field 'skill' must be a string or a list of strings`);
    }
    kinds[name] = {
      prefix: s.prefix,
      folder: s.folder,
      dedup: s.dedup,
      ...(s.skill !== undefined ? { skill: s.skill as string | string[] } : {}),
      ...(typeof s.parent === "string" ? { parent: s.parent } : {}),
      ...(typeof s.child_list === "string" ? { child_list: s.child_list } : {}),
      ...(typeof s.criteria === "string" ? { criteria: s.criteria } : {}),
    };
  }
  return kinds;
}

/** A bucket as declared in config: a criteria string and an optional template
 *  override (defaults to the section name). */
interface BucketConfig {
  criteria?: string;
  template?: TemplateType;
}

/** Parse the optional per-kind `buckets` map from config. A bucket entry is an
 *  object with optional `criteria`/`template` strings; a bucket may NOT itself
 *  declare `buckets` (one-level tree — the branch-XOR-leaf invariant). Returns
 *  only kinds that declared buckets; kinds without become leaves downstream. */
function parseBuckets(raw: unknown): Record<TemplateType, Record<string, BucketConfig>> {
  const out: Record<TemplateType, Record<string, BucketConfig>> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    const s = spec as Record<string, unknown>;
    if (s === null || typeof s !== "object" || s.buckets === undefined) continue;
    if (s.buckets === null || typeof s.buckets !== "object") {
      throw new Error(`wiki.json: section '${name}' field 'buckets' must be an object`);
    }
    const buckets: Record<string, BucketConfig> = {};
    for (const [bn, bspec] of Object.entries(s.buckets as Record<string, unknown>)) {
      if (bspec === null || typeof bspec !== "object") {
        throw new Error(`wiki.json: bucket '${name}.${bn}' must be an object`);
      }
      const b = bspec as Record<string, unknown>;
      if (b.buckets !== undefined) {
        throw new Error(`wiki.json: bucket '${name}.${bn}' may not declare nested 'buckets' (the tree is one level)`);
      }
      if (b.criteria !== undefined && typeof b.criteria !== "string") {
        throw new Error(`wiki.json: bucket '${name}.${bn}' field 'criteria' must be a string`);
      }
      if (b.template !== undefined && typeof b.template !== "string") {
        throw new Error(`wiki.json: bucket '${name}.${bn}' field 'template' must be a string`);
      }
      buckets[bn] = {
        ...(typeof b.criteria === "string" ? { criteria: b.criteria } : {}),
        ...(typeof b.template === "string" ? { template: b.template } : {}),
      };
    }
    out[name] = buckets;
  }
  return out;
}

/** Expand the flat kind map plus per-kind declared buckets into the section tree,
 *  validating the branch-XOR-leaf invariant and globally-unique bucket names.
 *  A kind with no declared buckets becomes a LEAF (one self-named bucket filing
 *  into the section folder); a kind with declared buckets becomes a BRANCH. */
function buildSections(
  kinds: Record<TemplateType, ArtifactSpec>,
  bucketsByKind: Record<TemplateType, Record<string, BucketConfig>>,
): SectionSpec[] {
  const sections: SectionSpec[] = [];
  const seenNames = new Set<string>();
  for (const [name, spec] of Object.entries(kinds) as [TemplateType, ArtifactSpec][]) {
    const declared = bucketsByKind[name];
    let buckets: BucketSpec[];
    let tree: "leaf" | "branch";
    if (declared === undefined) {
      // LEAF: one self-named bucket filing into the section folder. A leaf kind's
      // config `criteria` (ADR-0044) rides on its bucket so `create <kind> --help`
      // and `wiki schema` can surface it.
      tree = "leaf";
      buckets = [{ name, folder: spec.folder, template: name, ...(spec.criteria !== undefined ? { criteria: spec.criteria } : {}) }];
    } else {
      const bucketNames = Object.keys(declared);
      if (bucketNames.length === 0) {
        throw new Error(
          `wiki.json: section '${name}' declares an empty 'buckets' — a section is a branch (>=1 bucket) XOR a leaf (no buckets), not neither`,
        );
      }
      tree = "branch";
      buckets = Object.entries(declared).map(([bn, b]) => ({
        name: bn,
        folder: `${spec.folder}/${bn}`,
        template: b.template ?? name,
        ...(b.criteria !== undefined ? { criteria: b.criteria } : {}),
      }));
    }
    for (const bucket of buckets) {
      if (seenNames.has(bucket.name)) {
        throw new Error(`wiki.json: duplicate bucket name '${bucket.name}' — bucket/leaf names must be unique across the tree`);
      }
      seenNames.add(bucket.name);
    }
    sections.push({
      name,
      prefix: spec.prefix,
      folder: spec.folder,
      dedup: spec.dedup,
      ...(spec.skill !== undefined ? { skill: spec.skill } : {}),
      tree,
      buckets,
    });
  }
  return sections;
}

/** Build a Structure from a parsed kinds map (and optional declared buckets):
 *  precompute the reverse maps once, then expose them through the lookup methods.
 *  Pure — no I/O, no shared state. */
function buildStructure(
  kinds: Record<TemplateType, ArtifactSpec>,
  bucketsByKind: Record<TemplateType, Record<string, BucketConfig>> = {},
): Structure {
  const entries = Object.entries(kinds) as [TemplateType, ArtifactSpec][];
  const prefixToType = new Map(entries.map(([type, spec]) => [spec.prefix, type]));
  const folderToType = new Map(entries.map(([type, spec]) => [spec.folder, type]));
  // Two kinds sharing a folder makes folderToType (and path->kind resolution)
  // silently last-writer-wins. Reject it at load so a custom wiki.json fails loudly.
  if (folderToType.size !== entries.length) {
    const seen = new Set<string>();
    const dup = entries.find(([, spec]) => seen.size === (seen.add(spec.folder), seen.size));
    throw new Error(`wiki.json: two kinds share folder '${dup?.[1].folder}' — each kind needs a distinct folder`);
  }
  // A parent/child relationship that names a missing kind would fail deep in the
  // create flow with a confusing error; validate the edge here at load instead.
  for (const [type, spec] of entries) {
    if (spec.parent !== undefined && kinds[spec.parent] === undefined) {
      throw new Error(`wiki.json: kind '${type}' declares parent '${spec.parent}', which is not a defined kind`);
    }
  }
  const skillToKind = new Map<string, TemplateType>();
  for (const [type, spec] of entries) {
    for (const skill of skillsOf(spec)) {
      // Two kinds claiming the same skill would silently last-writer-win the
      // routing; fail loudly at load instead (mirrors the shared-folder check).
      const claimed = skillToKind.get(skill);
      if (claimed !== undefined && claimed !== type) {
        throw new Error(`wiki.json: skill '${skill}' is claimed by both '${claimed}' and '${type}' — a skill routes to one kind`);
      }
      skillToKind.set(skill, type);
    }
  }
  const folders = [...new Set(entries.map(([, spec]) => spec.folder))];
  const sections = buildSections(kinds, bucketsByKind);
  const bucketToSection = new Map<string, { section: SectionSpec; bucket: BucketSpec }>();
  for (const section of sections) {
    for (const bucket of section.buckets) {
      bucketToSection.set(bucket.name, { section, bucket });
    }
  }
  return {
    kinds,
    folders,
    sections,
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
    bucketFor(name) {
      return bucketToSection.get(name);
    },
  };
}

/**
 * The bundled default kinds, inlined as data so nothing reads a file at import
 * time. A vault with its own `wiki.json` overrides these via `loadStructure`; a
 * vault without one falls back to exactly this set. Mirrors the repo-root
 * `wiki.json` doc, which stays as the human-readable reference.
 *
 * PRD-0023 promoted the former single `doc` BRANCH kind (DOC prefix, docs/ with
 * architecture/research/runbooks/specs/notes/legacy buckets) into six first-class
 * LEAF kinds, each owning its own folder + id prefix. The old `doc` kind is gone;
 * each promoted kind carries the criteria the bucket used to hold (ADR-0044).
 */
/** A kind's authoring skills as a flat list (the `skill` field accepts one or many). */
export function skillsOf(spec: Pick<ArtifactSpec, "skill">): readonly string[] {
  if (spec.skill === undefined) return [];
  return typeof spec.skill === "string" ? [spec.skill] : spec.skill;
}

const DEFAULT_KINDS: Record<TemplateType, ArtifactSpec> = {
  prd: { prefix: "PRD", folder: "prds", dedup: true, skill: "to-prd", child_list: "slices" },
  slice: { prefix: "SLICE", folder: "slices", dedup: true, skill: "to-slices", parent: "prd" },
  decision: { prefix: "ADR", folder: "adrs", dedup: true, skill: "grill-with-docs" },
  architecture: { prefix: "ARCH", folder: "architecture", dedup: true, skill: ["improve-codebase-architecture", "improve"], criteria: "How the system is built: components, boundaries, data flow, structural decisions." },
  research: { prefix: "RES", folder: "research", dedup: true, skill: "research", criteria: "External findings, investigations, comparisons, and explorations feeding a decision." },
  runbooks: { prefix: "RUN", folder: "runbooks", dedup: true, criteria: "Operational how-to: step-by-step procedures for running, deploying, or recovering." },
  specs: { prefix: "SPEC", folder: "specs", dedup: true, criteria: "Specifications: precise contracts, formats, schemas, and interface definitions." },
  notes: { prefix: "NOTE", folder: "notes", dedup: true, criteria: "Catch-all for durable notes that fit no other bucket." },
  bug: { prefix: "BUG", folder: "bugs", dedup: true, skill: "diagnosing-bugs", criteria: "Bug reports and diagnosis writeups: symptom, mechanism, repro, root cause, fix status." },
  legacy: { prefix: "LEG", folder: "legacy", dedup: true, criteria: "Imported or historical material kept for reference, not actively maintained." },
  handoff: { prefix: "HANDOFF", folder: "handoffs", dedup: false, skill: "handoff" },
};

/** The bundled default structure (the promoted-kinds model), used when a vault has
 *  no wiki.json of its own. The only static Structure; every per-vault read goes
 *  through `loadStructure`, and consumers thread the result explicitly. */
export const DEFAULT_STRUCTURE: Structure = buildStructure(DEFAULT_KINDS);

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
  const rawKinds = (parsed as { kinds?: unknown }).kinds;
  return buildStructure(parseKinds(rawKinds), parseBuckets(rawKinds));
}

export { buildStructure };

/**
 * Resolve the config-declared parent backlink for a child kind (SLICE-0114),
 * replacing the hardcoded PRD<->slice special. A child kind declares `parent:
 * <parent-kind>`; the parent declares `child_list: <field>`. The parent id is
 * read from the child's `parent_<parent>` frontmatter field. Returns undefined
 * when the kind has no parent, the parent kind is unknown, or the parent declares
 * no child_list (a config-incomplete relationship backlinks nothing rather than
 * throwing). Pure — the caller does the I/O (pre-flight read + append).
 */
export function parentBacklink(
  structure: Structure,
  childType: TemplateType,
): { parentType: TemplateType; parentField: string; childListField: string } | undefined {
  const childSpec = structure.kinds[childType];
  const parentType = childSpec?.parent;
  if (parentType === undefined) return undefined;
  const parentSpec = structure.kinds[parentType];
  if (parentSpec?.child_list === undefined) return undefined;
  return { parentType, parentField: `parent_${parentType}`, childListField: parentSpec.child_list };
}
