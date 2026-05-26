import { access } from "node:fs/promises";

import { addCollection, addContext, embedCollection, updateCollection } from "../integrations/qmd";

export type QmdRegistrationResult = {
  collectionsRegistered: string[];
  contextsRegistered: number;
  indexed: boolean;
};

/** Fixed context map per ADR-0006 locked layout. */
const SUBFOLDER_CONTEXTS: Record<string, string> = {
  prds: "Product requirements documents. Scope, user stories, implementation decisions.",
  slices: "Tracer-bullet work units with TDD state machines. Implementation status, acceptance criteria.",
  adrs: "Architectural decision records. Rationale, tradeoffs, why questions.",
  handovers: "Session summaries with active state. Resuming context, recent work.",
  architecture: "Domain language and structural constraints. Terminology, naming.",
};

/** Research source conventional paths. */
const RESEARCH_SOURCES = [
  { name: "research-pi", path: "~/.pi/artifacts/research", context: "Cross-project research notes from Pi harness." },
  { name: "research-codex", path: "~/.codex/artifacts/research", context: "Cross-project research notes from Codex harness." },
  { name: "research-claude", path: "~/.claude/artifacts/research", context: "Cross-project research notes from Claude Code harness." },
  { name: "research-manual", path: "~/Research", context: "User-managed manual research notes." },
];

/**
 * Register project collection + context annotations + research sources.
 */
export async function registerQmdCollections(
  qmdCommand: string,
  projectName: string,
  projectPath: string,
  projectDescription: string,
  options?: { skipResearch?: boolean; skipIndexing?: boolean },
): Promise<QmdRegistrationResult> {
  const collectionsRegistered: string[] = [];
  let contextsRegistered = 0;

  // Register the project collection
  await addCollection(qmdCommand, projectName, projectPath, "**/*.md");
  collectionsRegistered.push(projectName);

  // Register root context
  await addContext(qmdCommand, `qmd://${projectName}`, projectDescription);
  contextsRegistered++;

  // Register subfolder context annotations
  for (const [subfolder, description] of Object.entries(SUBFOLDER_CONTEXTS)) {
    await addContext(qmdCommand, `qmd://${projectName}/${subfolder}`, description);
    contextsRegistered++;
  }

  // Register research sources (unless skipped)
  if (!options?.skipResearch) {
    for (const source of RESEARCH_SOURCES) {
      const resolvedPath = expandHome(source.path);
      if (await exists(resolvedPath)) {
        await addCollection(qmdCommand, source.name, resolvedPath, "**/*.md");
        await addContext(qmdCommand, `qmd://${source.name}`, source.context);
        collectionsRegistered.push(source.name);
        contextsRegistered++;
      }
    }
  }

  // Initial indexing (unless skipped)
  const indexed = !options?.skipIndexing;
  if (indexed) {
    await updateCollection(qmdCommand, projectName, false);
    await embedCollection(qmdCommand, projectName, false);
  }

  return { collectionsRegistered, contextsRegistered, indexed };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === "~") {
    return homeDirectory();
  }
  if (path.startsWith("~/")) {
    return `${homeDirectory()}${path.slice(1)}`;
  }
  return path;
}

function homeDirectory(): string {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) {
    throw new Error("HOME is not set");
  }
  return home;
}
