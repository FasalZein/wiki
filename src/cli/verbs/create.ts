import { join, relative } from "node:path";

import {
  DedupBlockedError,
  fieldsForDedupOverride,
  formatDedupBlocked,
  parseDedupOverride,
  QmdError,
  runDedupGate,
  type DedupOverride,
} from "../../artifacts/dedup";
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  createArtifact,
  readArtifact,
  removeArtifactFile,
  supersedeArtifact,
} from "../../artifacts/store";
import { specFor } from "../../artifacts/registry";
import { defaultCategoryForDocType, DOC_CATEGORIES, isDocCategory, type DocCategory } from "../../artifacts/registry";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { TemplateType } from "../../schema/load";
import type { CliResult } from "../dispatch";
import { emitJson, emitJsonError, jsonEnabled } from "../output";
import { parseCommand, stringValue } from "../parse";
import { resolveProject } from "../resolve-project";
import { unknownMessage, USAGE_REGISTRY } from "../usage";

export async function handleCreate(args: string[]): Promise<CliResult> {
  const [type, ...rest] = args;
  if (type === "prd") return createPrd(rest);
  if (type === "slice") return createSlice(rest);
  if (type === "decision") return createDecision(rest);
  if (type === "doc") return createDoc(rest);
  console.error(unknownMessage("artifact type", type ?? "", Object.keys(USAGE_REGISTRY.create?.subverbs ?? {})));
  return { code: 1 };
}

async function createPrd(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "project", "body", "force-new", "related-to", "supersedes"]);
  const project = await resolveProject(parsed);
  const title = stringValue(parsed.values, "title");
  const missing = missingFields({ project, title });
  if (missing) return missing;
  if (project === undefined || title === undefined) return { code: 1 };

  const body = await stdinOrValue(stringValue(parsed.values, "body"));
  return createWithSupersede({ type: "prd", project, dedupQuery: title, fields: { title }, rawValues: parsed.values, body });
}

async function createSlice(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(
    args,
    ["title", "project", "parent-prd", "body", "acceptance", "force-new", "related-to", "supersedes"],
    ["acceptance"],
  );
  const project = await resolveProject(parsed);
  const title = stringValue(parsed.values, "title");
  const missing = missingFields({ project, title });
  if (missing) return missing;
  if (project === undefined || title === undefined) return { code: 1 };

  // parent-prd is now an optional plain field — no existence gate, no backlink.
  // Relate a slice to a PRD (or anything) with --related-to instead.
  const parentPrd = stringValue(parsed.values, "parent-prd");
  const fields: Record<string, unknown> = { title, acceptance: stringListValue(parsed.values.acceptance) };
  if (parentPrd !== undefined) fields.parent_prd = parentPrd;

  const body = await stdinOrValue(stringValue(parsed.values, "body"));
  return createWithSupersede({
    type: "slice",
    project,
    dedupQuery: parentPrd !== undefined ? `${title} ${parentPrd}` : title,
    fields,
    rawValues: parsed.values,
    body,
  });
}

async function createDecision(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "context", "decision", "consequences", "project", "force-new", "related-to", "supersedes"]);
  const project = await resolveProject(parsed);
  const title = stringValue(parsed.values, "title");
  const context = stringValue(parsed.values, "context");
  const decision = stringValue(parsed.values, "decision");
  const consequences = stringValue(parsed.values, "consequences");
  const missing = missingFields({ project, title, context, decision, consequences });
  if (missing) return missing;
  if (project === undefined || title === undefined || context === undefined || decision === undefined || consequences === undefined) return { code: 1 };

  return createWithSupersede({ type: "decision", project, dedupQuery: `${title} ${context} ${decision}`, fields: { title, context, decision, consequences }, rawValues: parsed.values });
}

async function createDoc(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "project", "type", "category", "tags", "source-url", "body", "force-new", "related-to", "supersedes"]);
  const project = await resolveProject(parsed);
  const title = stringValue(parsed.values, "title");
  const docType = stringValue(parsed.values, "type");
  const missing = missingFields({ project, title, type: docType });
  if (missing) return missing;
  if (project === undefined || title === undefined || docType === undefined) return { code: 1 };

  const explicitCategory = stringValue(parsed.values, "category");
  if (explicitCategory !== undefined && !isDocCategory(explicitCategory)) {
    console.error(`unknown category: ${explicitCategory}`);
    console.error(`category must be one of: ${DOC_CATEGORIES.join(", ")}`);
    return { code: 1 };
  }
  const category = explicitCategory ?? defaultCategoryForDocType(docType);

  const fields: Record<string, unknown> = { title, type: docType };
  const tags = stringValue(parsed.values, "tags");
  if (tags !== undefined) fields.tags = tags.split(",").map((t) => t.trim());
  const sourceUrl = stringValue(parsed.values, "source-url");
  if (sourceUrl !== undefined) fields.source_url = sourceUrl;

  const body = await stdinOrValue(stringValue(parsed.values, "body"));
  return createWithSupersede({ type: "doc", project, dedupQuery: `${title} ${docType}`, fields, rawValues: parsed.values, category, body });
}

type CreateRequest = {
  type: TemplateType;
  project: string;
  dedupQuery: string;
  fields: Record<string, unknown>;
  rawValues: Record<string, string | string[] | boolean | undefined>;
  category?: DocCategory;
  body?: string;
};

async function createWithSupersede(req: CreateRequest): Promise<CliResult> {
  const { type, project, dedupQuery, fields, rawValues, category, body } = req;
  const override = parseOverride(rawValues);
  if (typeof override === "string") { console.error(override); return { code: 1 }; }

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  await assertProjectStructure(projectPath);
  try {
    if (override.kind === "supersedes") {
      await readArtifact({ type, vaultRoot, project, id: override.id });
    }
    const dedupBlock = await advisoryDedup(type, project, projectPath, dedupQuery, override);
    if (dedupBlock !== null) return dedupBlock;
    const artifact = await createArtifact({
      type,
      vaultRoot,
      project,
      category,
      body,
      fields: { ...fields, ...fieldsForDedupOverride(override) },
    });
    // Post-write steps mutate *other* artifacts and can fail (e.g. supersede a
    // type without a `superseded` status). If any throws, roll back the new
    // artifact so a half-applied create never leaves an orphan (P0.2/P0.3).
    try {
      if (override.kind === "supersedes") {
        await supersedeArtifact({ type, vaultRoot, project, id: override.id, by: artifact.id });
      }
    } catch (postWriteError) {
      await removeArtifactFile(artifact.path);
      throw postWriteError;
    }
    if (jsonEnabled()) {
      emitJson({
        id: artifact.id,
        type,
        project,
        path: relative(vaultRoot, artifact.path),
        status: artifact.fields.status ?? null,
        supersedes: override.kind === "supersedes" ? override.id : null,
      });
    } else {
      console.log(artifact.id);
      console.error(`created ${artifact.id} at ${relative(vaultRoot, artifact.path)}`);
      // P2.2: the dedup index only refreshes on `wiki sync`, so a just-created
      // artifact is invisible to the next dedup check until then. Remind once.
      if (specFor(type).dedup) console.error("note: run 'wiki sync' to index this artifact for future dedup checks");
    }
    return { code: 0 };
  } catch (error) {
    return handleCreateError(error);
  }
}

/**
 * Run the dedup gate. Returns a CliResult to abort the create, or null to
 * proceed. Dedup is advisory by default (warn + link); a *strong* match blocks
 * only in opt-in strict mode (config.dedup_strong_blocks). *Weak* matches always
 * stay advisory and proceed.
 */
async function advisoryDedup(type: TemplateType, project: string, projectPath: string, query: string, override: DedupOverride): Promise<CliResult | null> {
  if (override.kind !== "none" || !specFor(type).dedup) return null;
  let config;
  try {
    config = await loadProjectConfig(projectPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(`dedup check skipped: ${error.message.split("\n")[0]}`);
      return null;
    }
    throw error;
  }
  try {
    await runDedupGate({ type, project, projectPath, config, query, override });
    return null;
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      const strong = error.matches.some((match) => match.strength === "strong");
      if (strong && config.dedup_strong_blocks) {
        if (jsonEnabled()) {
          emitJsonError({ error: "strong duplicate match — refusing to create", matches: error.matches.map((m) => ({ path: m.path, score: m.score, strength: m.strength })) });
        } else {
          console.error(formatDedupBlocked(error));
          console.error("strong duplicate match — refusing to create. Pass --supersedes <id>, --related-to <id>, or --force-new \"reason\" to proceed.");
        }
        return { code: 1 };
      }
      console.error(formatDedupBlocked(error));
      console.error("(advisory — proceeding with create)");
      return null;
    }
    if (error instanceof QmdError) {
      console.error(`dedup check skipped: ${error.summary}`);
      return null;
    }
    throw error;
  }
}

function parseOverride(values: Record<string, string | string[] | boolean | undefined>) {
  return parseDedupOverride({
    forceNew: stringValue(values, "force-new"),
    relatedTo: stringValue(values, "related-to"),
    supersedes: stringValue(values, "supersedes"),
  });
}

function handleCreateError(error: unknown): CliResult {
  if (error instanceof ArtifactValidationError || error instanceof ArtifactNotFoundError) {
    if (jsonEnabled()) {
      const first = error instanceof ArtifactValidationError ? error.errors[0] : undefined;
      emitJsonError({ error: error.message, ...(first === undefined ? {} : { field: first.field, expected: first.expected }) });
    } else {
      console.error(error.message);
    }
    return { code: 1 };
  }
  if (error instanceof ProjectConfigError) {
    if (jsonEnabled()) emitJsonError({ error: error.message });
    else console.error(error.message);
    return { code: 10 };
  }
  throw error;
}

function missingFields(fields: Record<string, unknown>): CliResult | null {
  const missing = Object.entries(fields).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }
  return null;
}

function stringListValue(value: string | string[] | boolean | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

async function stdinOrValue(value: string | undefined): Promise<string | undefined> {
  if (value === "-") return Bun.stdin.text();
  return value;
}
