import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { exists } from "../util";

/** One distribution-health finding from `wiki doctor --setup`. */
export type SetupIssue = {
  type: "stale-binary" | "missing-bundle" | "unwired-hook" | "unreachable-subagent";
  message: string;
};

/**
 * Per-harness capture-reach honesty. Whether a harness's PostToolUse path is
 * KNOWN to reach the persist bridge. Pi is bridge-checkable from its on-disk
 * subagent allowlists; Codex/Claude reach is pre-decided 'unverified' per
 * ADR-0043 (the doctor does NOT execute a harness to confirm it). Reported by
 * `doctor --setup` instead of a blanket-healthy claim, so a green setup never
 * implies non-Pi subagents capture to the vault.
 */
export type CaptureReach = {
  harness: "pi" | "codex" | "claude-code";
  status: "checkable" | "unverified";
  detail: string;
};

/** The pre-decided per-harness capture reach (ADR-0043) — static, no harness run. */
export const CAPTURE_REACH: CaptureReach[] = [
  { harness: "pi", status: "checkable", detail: "bridge-checkable via ~/.pi subagent allowlists" },
  { harness: "codex", status: "unverified", detail: "Pi-subagent-only — non-Pi PostToolUse reach unverified (ADR-0043)" },
  {
    harness: "claude-code",
    status: "unverified",
    detail: "Pi-subagent-only — non-Pi PostToolUse reach unverified (ADR-0043)",
  },
];

export type SetupResult = {
  issues: SetupIssue[];
  clean: boolean;
  /** Per-harness capture reach — Pi checkable, non-Pi pre-decided unverified (ADR-0043). */
  captureReach: CaptureReach[];
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
  /** Subagents whose allowlist lacks the exact bridge, so their hook cannot fire. Empty when all reach it. */
  unreachableSubagents?: string[];
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

  // A wired parent hook says nothing about the subagent tier: each subagent's
  // hook fires only if its own allowlist carries the exact bridge. Name the ones
  // that can't, so a healthy global doesn't mask a silent subagent gap.
  const unreachable = facts.unreachableSubagents ?? [];
  if (unreachable.length > 0) {
    issues.push({
      type: "unreachable-subagent",
      message:
        `subagent persist hook cannot fire for: ${unreachable.join(", ")} — add @hsingjui/pi-hooks to each ` +
        `agent's extensions allowlist (~/.pi/agent/agents/<name>.md) so artifacts they author reach the vault.`,
    });
  }

  // Capture reach is reported honestly per harness, not folded into clean/issues:
  // a non-Pi 'unverified' is the expected steady state (ADR-0043), not a fixable
  // fault, so it must not flip `clean` — but it must never be hidden behind a
  // blanket-healthy line either.
  return { issues, clean: issues.length === 0, captureReach: CAPTURE_REACH };
}
