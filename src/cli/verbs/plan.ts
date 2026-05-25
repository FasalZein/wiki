import { join } from "node:path";

import { ArtifactValidationError, setField } from "../../artifacts/store";
import { loadProjectConfig, ProjectConfigError } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import {
  assertExistingDirectory,
  createDraftPlan,
  deletePlan,
  nextPlanId,
  PlanNotFoundError,
  readPlan,
  writePlan,
  type Plan,
} from "../../state/plans";
import { createPrdProgrammatic } from "./prd";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

type PlanField = keyof Plan;

const listFields: ReadonlySet<PlanField> = new Set([
  "problem_drafts",
  "solution_drafts",
  "acceptance_drafts",
  "user_stories_drafts",
]);

export async function handlePlan(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "create") {
    return createPlan(rest);
  }
  if (subverb === "show") {
    return showPlan(rest);
  }
  if (subverb === "set") {
    return setPlan(rest);
  }
  if (subverb === "append") {
    return appendPlan(rest);
  }
  if (subverb === "promote") {
    return promotePlan(rest);
  }
  console.error(`unknown plan subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function createPlan(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["title", "project", "repo"]);
  const title = stringValue(parsed.values, "title");
  const project = stringValue(parsed.values, "project");
  const missing = Object.entries({ title, project }).flatMap(([name, value]) => (value === undefined ? [name] : []));
  if (missing.length > 0) {
    console.error(`missing required field: ${missing.join(", ")}`);
    return { code: 1 };
  }
  if (title === undefined || project === undefined) {
    return { code: 1 };
  }

  const repo = await resolveRepo(parsed.values);
  if (repo === undefined) {
    return { code: 10 };
  }
  const id = await nextPlanId(repo);
  const plan = createDraftPlan(id, title, project);
  await writePlan(repo, plan);
  console.log(id);
  console.error(`created ${id}`);
  return { code: 0 };
}

async function showPlan(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "repo", "field"]);
  const id = parsed.positionals[0];
  if (id === undefined) {
    console.error("missing required field: id");
    return { code: 1 };
  }

  const repo = await resolveRepo(parsed.values);
  if (repo === undefined) {
    return { code: 10 };
  }

  try {
    const plan = await readPlan(repo, id);
    const field = stringValue(parsed.values, "field");
    if (field !== undefined) {
      const value = plan[field as PlanField];
      process.stdout.write(`${formatFieldValue(value)}\n`);
      return { code: 0 };
    }
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function setPlan(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "repo", "field"]);
  const id = parsed.positionals[0];
  const rawValue = parsed.positionals[1];
  const field = stringValue(parsed.values, "field");
  if (id === undefined || field === undefined || rawValue === undefined) {
    console.error("missing required field: id, field, value");
    return { code: 1 };
  }
  const repo = await resolveRepo(parsed.values);
  if (repo === undefined) {
    return { code: 10 };
  }

  try {
    const plan = await readPlan(repo, id);
    if (!isPlanField(field)) {
      console.error(`unknown field: ${field}`);
      return { code: 1 };
    }
    const rawInput = rawValue === "-" ? await Bun.stdin.text() : rawValue;
    const value = listFields.has(field) ? rawInput.split(/\r?\n/).filter((line) => line.length > 0) : rawInput;
    const nextPlan = { ...plan, [field]: value };
    if (!isValidPlan(nextPlan)) {
      console.error(`invalid value for field: ${field}`);
      return { code: 1 };
    }
    await writePlan(repo, nextPlan);
    console.error(`updated ${id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function appendPlan(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "repo", "field"]);
  const id = parsed.positionals[0];
  const value = parsed.positionals[1];
  const field = stringValue(parsed.values, "field");
  if (id === undefined || field === undefined || value === undefined) {
    console.error("missing required field: id, field, value");
    return { code: 1 };
  }
  const repo = await resolveRepo(parsed.values);
  if (repo === undefined) {
    return { code: 10 };
  }

  try {
    const plan = await readPlan(repo, id);
    if (!isPlanField(field) || !listFields.has(field)) {
      console.error(`${field}: not a list field`);
      return { code: 1 };
    }
    const current = plan[field];
    if (!Array.isArray(current)) {
      console.error(`${field}: not a list field`);
      return { code: 1 };
    }
    await writePlan(repo, { ...plan, [field]: [...current, value] });
    console.error(`updated ${id}`);
    return { code: 0 };
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function promotePlan(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project", "repo"]);
  const id = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (id === undefined || project === undefined) {
    console.error("missing required field: id, project");
    return { code: 1 };
  }
  const repo = await resolveRepo(parsed.values);
  if (repo === undefined) {
    return { code: 10 };
  }

  try {
    const plan = await readPlan(repo, id);
    if (plan.project !== project) {
      console.error(`project mismatch: plan ${id} belongs to ${plan.project}`);
      return { code: 1 };
    }
    if (plan.title.trim().length === 0) {
      console.error("missing required PRD field: title");
      return { code: 1 };
    }

    let prdId: string | undefined;
    try {
      const prd = await createPrdProgrammatic({ title: plan.title, project: plan.project });
      prdId = prd.id;
      await setDraftField(prdId, plan.project, "problem_statement", plan.problem_drafts);
      await setDraftField(prdId, plan.project, "solution", plan.solution_drafts);
      await setDraftField(prdId, plan.project, "user_stories", plan.user_stories_drafts);
      if (plan.acceptance_drafts.length > 0) {
        console.error("PRD acceptance criteria are not list-typed in this schema; skipping acceptance drafts");
      }
      await deletePlan(repo, id);
      console.log(prdId);
      console.error(`created ${prdId} from ${id}`);
      return { code: 0 };
    } catch (error) {
      console.error(`promotion failed; plan still present: ${id}${prdId === undefined ? "" : `; created PRD: ${prdId}`}`);
      if (error instanceof ArtifactValidationError || error instanceof Error) {
        console.error(error.message);
      }
      return { code: error instanceof ArtifactValidationError ? 1 : 10 };
    }
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      console.error(error.message);
      return { code: 1 };
    }
    throw error;
  }
}

async function setDraftField(prdId: string, project: string, field: string, drafts: string[]): Promise<void> {
  if (drafts.length === 0) return;
  const vaultRoot = await getVaultRoot();
  await setField({ type: "prd", vaultRoot, project, id: prdId, field, value: drafts.join("\n\n") });
}

async function resolveRepo(values: Record<string, string | boolean | string[] | undefined>): Promise<string | undefined> {
  const explicit = stringValue(values, "repo");
  if (explicit !== undefined) {
    try {
      await assertExistingDirectory(explicit);
      return explicit;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  const project = stringValue(values, "project");
  if (project === undefined) {
    console.error("missing repo: pass --repo <path>, or pass --project <p> so _project.md can provide repo");
    return undefined;
  }

  try {
    const vaultRoot = await getVaultRoot();
    const config = await loadProjectConfig(join(vaultRoot, "projects", project));
    await assertExistingDirectory(config.repo);
    return config.repo;
  } catch (error) {
    if (error instanceof ProjectConfigError || error instanceof Error) {
      console.error(error.message);
      return undefined;
    }
    throw error;
  }
}

function formatFieldValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join("\n");
  }
  if (value === undefined) {
    return "";
  }
  return String(value);
}

function isPlanField(field: string): field is PlanField {
  return [
    "id",
    "title",
    "project",
    "status",
    "problem_drafts",
    "solution_drafts",
    "acceptance_drafts",
    "user_stories_drafts",
    "notes",
  ].includes(field);
}

function isValidPlan(value: Plan): value is Plan {
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.project === "string" &&
    (value.status === "draft" || value.status === "ready-to-promote") &&
    Array.isArray(value.problem_drafts) &&
    value.problem_drafts.every(isString) &&
    Array.isArray(value.solution_drafts) &&
    value.solution_drafts.every(isString) &&
    Array.isArray(value.acceptance_drafts) &&
    value.acceptance_drafts.every(isString) &&
    Array.isArray(value.user_stories_drafts) &&
    value.user_stories_drafts.every(isString) &&
    typeof value.notes === "string"
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
