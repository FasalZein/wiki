/**
 * The create transaction — planning half (ADR-0045 item 3). `planCreate` is the
 * PURE decision: given a kind, the raw field values, the body text, and the raw
 * dedup-override flags, it returns either a validated {@link CreatePlan} or a
 * typed {@link CreatePlanError} the caller formats. No console, no process.exit,
 * no writes — the only I/O is the (memoized) kind read the caller already did.
 *
 * The NOTE-0010 ordering (cheap validation BEFORE any dedup consideration) is a
 * STRUCTURAL property here: a `CreatePlan` cannot be constructed without passing
 * field + body validation first, so a caller physically cannot reach the dedup
 * gate (which runs in the verb, on a returned plan) with unvalidated fields.
 *
 * The transaction half — snapshot → write → supersede → backlink → rollback —
 * is `executeCreate` in store.ts, which consumes the plan.
 */

import type { Kind } from "./body";
import { BodyParseError } from "./body";
import { parseDedupOverride, type DedupOverride } from "./dedup";
import { parentBacklink, type Structure } from "./registry";
import type { TemplateType } from "../schema/load";
import type { ValidationError } from "../schema/types";
import { validate } from "../schema/validate";

/** Fields the CLI mints at write time (id/aliases/dates) — excluded from the
 *  pre-write validation, which runs before those exist. Same set preflight used. */
const MINTED: ReadonlySet<string> = new Set(["id", "aliases", "created", "updated", "session_date"]);

/** A create target the transaction must confirm exists before writing (a parent to
 *  backlink, or a `--related-to` id). The read happens in executeCreate; planCreate
 *  only resolves WHICH artifact (kind + id) must be present. */
export type CreateTargetRef = { type: TemplateType; id: string };

/** A validated create plan: everything executeCreate needs to run the transaction,
 *  plus the dedup query the verb scores against between plan and execute. */
export type CreatePlan = {
  type: TemplateType;
  project: string;
  /** Bucket subfolder (already resolved by the verb against the tree), or undefined. */
  category: string | undefined;
  /** Normalized field values (schema fields + placeholders), sans project/minted. */
  fields: Record<string, unknown>;
  /** Authored body markdown (stdin-resolved), or undefined. */
  body: string | undefined;
  override: DedupOverride;
  /** title + summary (ADR-0044) — the signal the dedup gate scores against. */
  dedupQuery: string;
  /** Machine-owned link-list sections parsed out of the body into their fields. */
  absorbed: Record<string, unknown>;
  /** Parent whose child_list this create backlinks (present only when a parent id
   *  is supplied for a kind that declares `parent:`). */
  parentRef?: CreateTargetRef;
  /** `--related-to` target, with its kind inferred from the id prefix. */
  relatedRef?: CreateTargetRef;
};

/** Why a plan could not be produced. `validation` carries the field errors verbatim
 *  (the verb reconstructs the same ArtifactValidationError formatting); `message` is
 *  a pre-formatted one-liner (bad override, unresolvable --related-to). */
export type CreatePlanError =
  | { kind: "validation"; errors: ValidationError[] }
  | { kind: "message"; message: string };

export type CreatePlanResult = { ok: true; plan: CreatePlan } | { ok: false; error: CreatePlanError };

/** Raw inputs the verb extracts from argv before it has a plan. */
export type PlanCreateInput = {
  project: string;
  fields: Record<string, unknown>;
  body: string | undefined;
  category: string | undefined;
  forceNew: string | undefined;
  relatedTo: string | undefined;
  supersedes: string | undefined;
};

/**
 * Build a validated create plan, or a typed error. Order is load-bearing and
 * mirrors the old createGeneric→createWithSupersede sequence: cheap validation
 * first (BUG-C/NOTE-0010), then override parsing, then target resolution.
 */
export function planCreate(
  type: TemplateType,
  kind: Kind,
  structure: Structure,
  input: PlanCreateInput,
): CreatePlanResult {
  const { project, fields, body, category } = input;

  // (1) Cheap validation FIRST — body-section shape + field bounds, before any
  // dedup consideration. Absorb machine-owned link-list sections into their
  // backing fields (same as createArtifact) so they validate alongside the flags.
  let absorbed: Record<string, unknown> = {};
  if (body !== undefined) {
    try {
      absorbed = kind.parseBody(body).absorbed;
    } catch (error) {
      if (error instanceof BodyParseError) {
        return { ok: false, error: { kind: "validation", errors: [{ field: "body", reason: error.message }] } };
      }
      throw error;
    }
  }
  const checkSchema = { ...kind.schema, fields: kind.schema.fields.filter((field) => !MINTED.has(field.name)) };
  const validated = validate(checkSchema, kind.applyDefaults({ ...fields, project, ...absorbed }));
  if (!validated.ok) {
    return { ok: false, error: { kind: "validation", errors: validated.errors } };
  }

  // (2) Dedup override (`--force-new` / `--related-to` / `--supersedes`).
  const override = parseDedupOverride({ forceNew: input.forceNew, relatedTo: input.relatedTo, supersedes: input.supersedes });
  if (typeof override === "string") {
    return { ok: false, error: { kind: "message", message: override } };
  }

  // (3) `--related-to`: infer the target's kind from its id prefix; a typo'd id
  // that maps to no kind is a plan error (was createWithSupersede's guard).
  let relatedRef: CreateTargetRef | undefined;
  if (override.kind === "related-to") {
    const relatedType = structure.typeForId(override.id);
    if (relatedType === undefined) {
      return { ok: false, error: { kind: "message", message: `--related-to: cannot infer artifact type from id: ${override.id}` } };
    }
    relatedRef = { type: relatedType, id: override.id };
  }

  // (4) Parent backlink requirement: only when this kind declares `parent:` and a
  // parent id was supplied. executeCreate confirms it exists before writing.
  let parentRef: CreateTargetRef | undefined;
  const backlink = parentBacklink(structure, type);
  if (backlink !== undefined) {
    const parentId = fields[backlink.parentField];
    if (typeof parentId === "string" && parentId.length > 0) {
      parentRef = { type: backlink.parentType, id: parentId };
    }
  }

  // (5) Dedup query: title + summary, query-side only (ADR-0044).
  const dedupQuery = [fields.title, fields.summary]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");

  return { ok: true, plan: { type, project, category, fields, body, override, dedupQuery, absorbed, parentRef, relatedRef } };
}
