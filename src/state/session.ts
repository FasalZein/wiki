import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SessionState = {
  project: string;
  updated: string;
};

export function sessionPath(repo: string): string {
  return join(repo, ".wiki", "state", "session.json");
}

export async function readSession(repo: string): Promise<SessionState | null> {
  const path = sessionPath(repo);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
  const parsed = JSON.parse(content);
  if (!isSessionState(parsed)) {
    throw new Error(`invalid session JSON: ${path}`);
  }
  return parsed;
}

export async function writeSession(repo: string, session: Omit<SessionState, "updated"> & { updated?: string }): Promise<SessionState> {
  const next: SessionState = { ...session, updated: session.updated ?? new Date().toISOString() };
  const path = sessionPath(repo);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function clearSession(repo: string): Promise<void> {
  await rm(sessionPath(repo), { force: true });
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content);
  await rename(tempPath, path);
}

function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) return false;
  return typeof value.project === "string" && typeof value.updated === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
