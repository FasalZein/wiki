import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { exists } from "../util";

/** One distribution-health finding from `wiki doctor --setup`. */
export type SetupIssue = {
  type: "stale-binary" | "missing-bundle" | "unwired-hook";
  message: string;
};

export type SetupResult = {
  issues: SetupIssue[];
  clean: boolean;
};

/** The resolved facts `doctor --setup` checks; injectable so tests need no real install. */
export interface SetupFacts {
  /** The running bundled entry (dist/cli.js) whose mtime is the binary's freshness. */
  binaryPath: string;
  /** The source tree to compare against; undefined when running from a relocated bundle (no source nearby). */
  srcDir: string | undefined;
  /** The vendored skill bundle that should ship with the tool. */
  skillBundlePath: string;
  /** Whether the persist-reminder hook is wired in any runtime/scope. */
  hookWired: boolean;
}

/** Newest mtime (ms) under a directory tree, or 0 if it can't be read. */
async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestMtime(full));
    } else {
      try {
        newest = Math.max(newest, (await stat(full)).mtimeMs);
      } catch {
        // unreadable entry — skip
      }
    }
  }
  return newest;
}

/**
 * Distribution health: is the built binary current with its source, does the
 * skill bundle ship alongside it, and is the persist hook wired? Reported by
 * `wiki doctor --setup`. Pure over its injected facts so it's testable without
 * a real install or a real settings file.
 */
export async function evaluateSetup(facts: SetupFacts): Promise<SetupResult> {
  const issues: SetupIssue[] = [];

  // Binary freshness: only meaningful when the source tree sits next to the binary
  // (a dev/repo checkout). A relocated dist has no source, so freshness is N/A.
  if (facts.srcDir !== undefined && (await exists(facts.srcDir))) {
    const binMtime = (await exists(facts.binaryPath)) ? (await stat(facts.binaryPath)).mtimeMs : 0;
    const srcMtime = await newestMtime(facts.srcDir);
    if (binMtime === 0) {
      issues.push({ type: "stale-binary", message: `binary missing at ${facts.binaryPath} — run: bun run build` });
    } else if (srcMtime > binMtime) {
      issues.push({
        type: "stale-binary",
        message: `binary is stale — source changed after the last build (${facts.binaryPath}). Run: bun run build`,
      });
    }
  }

  if (!(await exists(facts.skillBundlePath))) {
    issues.push({
      type: "missing-bundle",
      message: `skill bundle missing at ${facts.skillBundlePath} — reinstall or restore the bundled skill.`,
    });
  }

  if (!facts.hookWired) {
    issues.push({
      type: "unwired-hook",
      message: "persist hook not wired in any runtime — run: wiki hooks install --runtime <claude-code|codex|pi> --global",
    });
  }

  return { issues, clean: issues.length === 0 };
}
