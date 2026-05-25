import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "../../artifacts/store";
import { getTerm, listTerms, upsertTerm } from "../../artifacts/terms";
import { getVaultRoot } from "../../config/vault";
import { parseCommand, stringValue } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleTerm(args: string[]): Promise<CliResult> {
  const [subverb, ...rest] = args;
  if (subverb === "set") {
    return setTerm(rest);
  }
  if (subverb === "show") {
    return showTerm(rest);
  }
  if (subverb === "list") {
    return listProjectTerms(rest);
  }
  console.error(`unknown term subverb: ${subverb ?? ""}`.trim());
  return { code: 1 };
}

async function setTerm(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const name = parsed.positionals[0];
  const rawDefinition = parsed.positionals[1];
  const project = stringValue(parsed.values, "project");
  if (name === undefined || rawDefinition === undefined || project === undefined) {
    console.error("missing required field: name, definition, project");
    return { code: 1 };
  }

  const definition = rawDefinition === "-" ? await Bun.stdin.text() : rawDefinition;
  const vaultRoot = await getVaultRoot();
  const path = termPath(vaultRoot, project);
  try {
    const existing = await readOptionalFile(path);
    const content = upsertTerm(existing, name, definition);
    await mkdir(join(vaultRoot, "projects", project, "architecture"), { recursive: true });
    await atomicWrite(path, content);
    console.error(`updated term: ${name}`);
    return { code: 0 };
  } catch (error) {
    if (isIoError(error)) {
      console.error(error.message);
      return { code: 10 };
    }
    throw error;
  }
}

async function showTerm(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const name = parsed.positionals[0];
  const project = stringValue(parsed.values, "project");
  if (name === undefined || project === undefined) {
    console.error("missing required field: name, project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const text = await readOptionalFile(termPath(vaultRoot, project));
  const body = getTerm(text, name);
  if (body === undefined) {
    console.error(`term not found: ${name}`);
    return { code: 1 };
  }
  process.stdout.write(`${body}\n`);
  return { code: 0 };
}

async function listProjectTerms(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const project = stringValue(parsed.values, "project");
  if (project === undefined) {
    console.error("missing required field: project");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const names = listTerms(await readOptionalFile(termPath(vaultRoot, project)));
  if (names.length > 0) {
    process.stdout.write(`${names.join("\n")}\n`);
  }
  return { code: 0 };
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return "";
    }
    throw error;
  }
}

function termPath(vaultRoot: string, project: string): string {
  return join(vaultRoot, "projects", project, "architecture", "domain-language.md");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isIoError(error: unknown): error is Error {
  return error instanceof Error && "code" in error;
}
