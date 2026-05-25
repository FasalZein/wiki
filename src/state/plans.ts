import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Plan = {
  id: string;
  title: string;
  project: string;
  status: "draft" | "ready-to-promote";
  problem_drafts: string[];
  solution_drafts: string[];
  acceptance_drafts: string[];
  user_stories_drafts: string[];
  notes: string;
};

export class PlanNotFoundError extends Error {
  constructor(id: string) {
    super(`plan not found: ${id}`);
  }
}

export async function nextPlanId(repo: string): Promise<string> {
  const plans = await listPlans(repo);
  const max = plans.reduce((highest, plan) => {
    const match = /^PLAN-(\d+)$/.exec(plan.id);
    if (match === null) return highest;
    return Math.max(highest, Number(match[1]));
  }, 0);
  return `PLAN-${String(max + 1).padStart(4, "0")}`;
}

export async function listPlans(repo: string): Promise<Plan[]> {
  const dir = plansDirectory(repo);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
  const plans: Plan[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    plans.push(await readPlanFile(join(dir, entry)));
  }
  return plans;
}

export async function readPlan(repo: string, id: string): Promise<Plan> {
  try {
    return await readPlanFile(planPath(repo, id));
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new PlanNotFoundError(id);
    }
    throw error;
  }
}

export async function writePlan(repo: string, plan: Plan): Promise<void> {
  const dir = plansDirectory(repo);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(planPath(repo, plan.id), `${JSON.stringify(plan, null, 2)}\n`);
}

export async function deletePlan(repo: string, id: string): Promise<void> {
  await unlink(planPath(repo, id));
}

export function createDraftPlan(id: string, title: string, project: string): Plan {
  return {
    id,
    title,
    project,
    status: "draft",
    problem_drafts: [],
    solution_drafts: [],
    acceptance_drafts: [],
    user_stories_drafts: [],
    notes: "",
  };
}

export function plansDirectory(repo: string): string {
  return join(repo, ".wiki", "state", "plans");
}

export function planPath(repo: string, id: string): string {
  return join(plansDirectory(repo), `${id}.json`);
}

export async function assertExistingDirectory(path: string): Promise<void> {
  const stats = await stat(path);
  if (!stats.isDirectory()) {
    throw new Error(`not a directory: ${path}`);
  }
}

async function readPlanFile(path: string): Promise<Plan> {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!isPlan(parsed)) {
    throw new Error(`invalid plan JSON: ${path}`);
  }
  return parsed;
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

function isPlan(value: unknown): value is Plan {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.project === "string" &&
    (value.status === "draft" || value.status === "ready-to-promote") &&
    isStringArray(value.problem_drafts) &&
    isStringArray(value.solution_drafts) &&
    isStringArray(value.acceptance_drafts) &&
    isStringArray(value.user_stories_drafts) &&
    typeof value.notes === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
