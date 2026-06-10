/**
 * Repo pointer-block stamping for `wiki project link`.
 *
 * Stamps a sentinel-versioned wiki block at the top of a target repo's
 * AGENTS.md and CLAUDE.md. Re-running is idempotent: any existing block
 * (any version) is replaced by matching on the sentinel markers.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Increment this when the block format changes incompatibly. */
export const BLOCK_VERSION = 2;

const BEGIN_RE = /<!-- wiki:begin v\d+ project=[^\s]+ -->/;
const END_MARKER = "<!-- wiki:end -->";

export function buildPointerBlock(project: string): string {
  const lines = [
    `<!-- wiki:begin v${BLOCK_VERSION} project=${project} -->`,
    `## Wiki vault`,
    ``,
    `All PRDs, slices, ADRs, decisions, docs, glossary terms, and handovers for this project live in the wiki vault (project: ${project}), **never in this repo and never in GitHub Issues** — no repo \`CONTEXT.md\`, no \`docs/adr/\`, no OS temp dirs, even when a skill says to write them.`,
    ``,
    `- For any delivery work, load the \`wiki\` skill first.`,
    `- Recall context with: \`wiki search "<query>" --project ${project}\``,
    ``,
    `<!-- wiki:end -->`,
  ];
  return lines.join("\n");
}

/**
 * Stamp the pointer block at the top of `filePath`.
 * Creates the file if absent. Replaces any existing wiki block idempotently.
 */
export async function stampPointerBlock(filePath: string, project: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
    // File doesn't exist — start with empty string
  }

  const block = buildPointerBlock(project);
  const newContent = spliceBlock(existing, block);
  await writeFile(filePath, newContent, "utf8");
}

/**
 * Replace an existing wiki block in `content` with `newBlock`, or prepend it
 * if none exists. Returns the resulting content string.
 */
function spliceBlock(content: string, newBlock: string): string {
  const beginIdx = content.search(BEGIN_RE);
  if (beginIdx === -1) {
    // No existing block — prepend
    if (content.length === 0) {
      return newBlock + "\n";
    }
    return newBlock + "\n\n" + content;
  }

  const endIdx = content.indexOf(END_MARKER, beginIdx);
  if (endIdx === -1) {
    // Malformed (begin without end) — just prepend
    return newBlock + "\n\n" + content;
  }

  const afterEnd = endIdx + END_MARKER.length;
  // Replace the block in place, preserving whatever surrounds it.
  const prefix = content.slice(0, beginIdx);
  // Strip any trailing newline right after the end marker so we don't accumulate blank lines
  const remainder = content.slice(afterEnd).replace(/^\n/, "");
  if (remainder.length === 0) {
    return prefix + newBlock + "\n";
  }
  return prefix + newBlock + "\n\n" + remainder;
}

/**
 * Return the file names that should receive the pointer block.
 */
export const LINK_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Stamp all target files in `repoDir` for the given project.
 */
export async function stampRepo(repoDir: string, project: string): Promise<void> {
  await Promise.all(
    LINK_FILES.map((file) => stampPointerBlock(join(repoDir, file), project)),
  );
}
