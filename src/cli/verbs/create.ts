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
  setFields,
} from "../../artifacts/store";
import { ARTIFACTS } from "../../artifacts/registry";
import { defaultCategoryForDocType, DOC_CATEGORIES, isDocCategory, type DocCategory } from "../../artifacts/registry";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import type { TemplateType } from "../../schema/load";
import { readSession } from "../../state/session";
import type { CliResult } from "../dispatch";
import { parseCommand, stringValue, type ParsedCommand } from "../parse";
import { phaseDocOptions, writePhaseDocToStderr } from "../phase-docs";
import { unknownMessage, USAGE_REGISTRY } from "../usage";

export async function handleCreate(args: string[]): Promise<CliResult> {
  const [type, ...rest] = args;
  if (type === "prd") return createPrd(rest);
  if (type === "slice") return createSlice(rest);
  if (type === "decision") return createDecision(rest);
  if (type === "handover") return createHandover(rest);
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
  const parentPrd = stringValue(parsed.values, "parent-prd");
  const missing = missingFields({ project, title, "parent-prd": parentPrd });
  if (missing) return missing;
  if (project === undefined || title === undefined || parentPrd === undefined) return { code: 1 };

  const vaultRoot = await getVaultRoot();
  const projectPath = join(vaultRoot, "projects", project);
  await assertProjectStructure(projectPath);
  try {
    await readArtifact({ type: "prd", vaultRoot, project, id: parentPrd });
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      console.error(`parent PRD not found: ${parentPrd}`);
      return { code: 1 };
    }
    throw error;
  }

  const body = await stdinOrValue(stringValue(parsed.values, "body"));
  return createWithSupersede({
    type: "slice",
    project,
    dedupQuery: `${title} ${parentPrd}`,
    fields: { title, parent_prd: parentPrd, acceptance: stringListValue(parsed.values.acceptance) },
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
    await advisoryDedup(type, project, projectPath, dedupQuery, override);
    const artifact = await createArtifact({
      type,
      vaultRoot,
      project,
      category,
      body,
      fields: { ...fields, ...fieldsForDedupOverride(override) },
    });
    if (override.kind === "supersedes") {
      await setFields({ type, vaultRoot, project, id: override.id, fields: { status: "superseded", superseded_by: artifact.id } });
    }
    console.log(artifact.id);
    console.error(`created ${artifact.id} at ${relative(vaultRoot, artifact.path)}`);
    return { code: 0 };
  } catch (error) {
    return handleCreateError(error);
  }
}

async function createHandover(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(
    args,
    ["project", "phase", "next-phase", "active-prd", "produced", "open", "active-slice", "decision", "suggested-skill", "doc-phase"],
    ["active-slice", "decision", "suggested-skill"],
    ["no-doc"],
  );
  const vaultRoot = await getVaultRoot();
  const explicitProject = stringValue(parsed.values, "project");
  const session = explicitProject === undefined ? await readSessionFromCwd() : await readSessionForProject(vaultRoot, explicitProject);
  const project = explicitProject ?? session?.project;
  const phase = stringValue(parsed.values, "phase") ?? session?.phase;  const missing = missingFields({ project, phase });
  if (missing) return missing;
  if (project === undefined || phase === undefined) return { code: 1 };

  const produced = stringValue(parsed.values, "produced");
  const open = stringValue(parsed.values, "open");
  if (produced === "-" && open === "-") {
    console.error("only one of --produced or --open may read from stdin per invocation");
    return { code: 1 };
  }

  await assertProjectStructure(join(vaultRoot, "projects", project));
  try {
    const explicitSlices = stringListValue(parsed.values["active-slice"]);
    const fields: Record<string, unknown> = {
      phase,
      active_slices: explicitSlices.length > 0 ? explicitSlices : session?.active_slices ?? [],
      decisions_made: stringListValue(parsed.values.decision),
      suggested_skills: stringListValue(parsed.values["suggested-skill"]),
    };
    addStringField(fields, "next_phase", stringValue(parsed.values, "next-phase"));
    addStringField(fields, "active_prd", stringValue(parsed.values, "active-prd") ?? session?.active_prd);
    addStringField(fields, "produced", await stdinOrValue(produced));
    addStringField(fields, "open", await stdinOrValue(open));

    const artifact = await createArtifact({ type: "handover", vaultRoot, project, fields });
    console.log(artifact.id);
    console.error(`created ${artifact.id}`);
    await writePhaseDocToStderr(stringValue(parsed.values, "next-phase") ?? "ad-hoc", phaseDocOptions(parsed));
    return { code: 0 };
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function advisoryDedup(type: TemplateType, project: string, projectPath: string, query: string, override: DedupOverride): Promise<void> {
  if (override.kind !== "none" || !ARTIFACTS[type].dedup) return;
  try {
    const config = await loadProjectConfig(projectPath);
    await runDedupGate({ type, project, projectPath, config, query, override });
  } catch (error) {
    if (error instanceof DedupBlockedError) {
      console.error(formatDedupBlocked(error));
      console.error("(advisory — proceeding with create)");
      return;
    }
    if (error instanceof QmdError || error instanceof ProjectConfigError) {
      const errorLine = error instanceof QmdError ? error.summary : error.message.split("\n")[0] ?? error.message;
      console.error(`dedup check skipped: ${errorLine}`);
      return;
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
    console.error(error.message);
    return { code: 1 };
  }
  if (error instanceof ProjectConfigError) {
    console.error(error.message);
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

function addStringField(fields: Record<string, unknown>, name: string, value: string | undefined): void {
  if (value !== undefined) fields[name] = value;
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

async function readSessionFromCwd() {
  const session = await readSession(process.cwd());
  if (session === null) return null;
  try {
    const vaultRoot = await getVaultRoot();
    await assertProjectStructure(join(vaultRoot, "projects", session.project));
    return session;
  } catch {
    return null;
  }
}

/**
 * Resolve the target project for a create verb: an explicit --project wins,
 * otherwise fall back to the project of the repo's active session. This lets
 * create commands run without repeating --project once a session is started,
 * matching how status/handover already default. Returns undefined when neither
 * an explicit flag nor a valid repo session is present.
 */
async function resolveProject(parsed: ParsedCommand): Promise<string | undefined> {
  const explicit = stringValue(parsed.values, "project");
  if (explicit !== undefined) return explicit;
  return (await readSessionFromCwd())?.project;
}

async function readSessionForProject(vaultRoot: string, project: string) {
  try {
    const config = await loadProjectConfig(join(vaultRoot, "projects", project));
    return readSession(config.repo);
  } catch {
    return null;
  }
}
