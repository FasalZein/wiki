// Shared CLI test helper. runCli calls the command in process; spawnCli runs the real bin/wiki.js process.
// Use spawnCli only where the process is the subject: exit codes through the real process, the single stdout line,
// signals, two-process races, per-process --import guards and process-start environment such as the locale.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";

export const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
type CliResult = { status: number; stdout: string; stderr: string };
type CliEnv = Readonly<Record<string, string | undefined>>;

/** Runs one command in process. WIKI_VAULT is empty unless opts.env sets it; the caller's environment never selects a vault.
 * An aborted signal acts like SIGINT or SIGTERM delivered to the bin while the command listens for interrupts. */
export async function runCli(args: readonly string[], opts: { env?: CliEnv; signal?: AbortSignal } = {}): Promise<CliResult> {
  const { signal } = opts;
  const result = await run(args, {
    env: { WIKI_VAULT: "", ...opts.env },
    interrupts: signal && (listener => {
      if (signal.aborted) listener();
      signal.addEventListener("abort", listener);
      return () => signal.removeEventListener("abort", listener);
    }),
  });
  return { status: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** Runs one --json command against a vault in process and parses its one stdout line; stderr must stay empty. */
export async function runJson(vault: string, ...args: string[]) {
  const result = await runCli(["--json", "--vault", vault, ...args]);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "CLI must emit exactly one final JSON object: " + result.stdout);
  return { status: result.status, data: JSON.parse(lines[0] ?? "") };
}

/** Runs one --json command through the real bin/wiki.js and parses its one stdout line; stderr must stay empty. */
export function spawnJson(args: readonly string[], opts: Parameters<typeof spawnCli>[1] = {}) {
  const result = spawnCli(["--json", ...args], opts);
  assert.equal(result.error, undefined); assert.equal(result.signal, null, result.stderr); assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "CLI must emit exactly one final JSON object: " + result.stdout);
  return { status: result.status, data: JSON.parse(lines[0] ?? "") };
}

/** Runs the real bin/wiki.js. imports are preloaded with --import (fault-injection guards patch process globals). */
export function spawnCli(args: readonly string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; imports?: readonly string[]; timeout?: number; killSignal?: NodeJS.Signals; input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [...(opts.imports ?? []).flatMap(file => ["--import", file]), BIN, ...args], {
    encoding: "utf8", cwd: opts.cwd, input: opts.input, timeout: opts.timeout, killSignal: opts.killSignal,
    env: { ...process.env, WIKI_VAULT: "", ...opts.env },
  });
}
