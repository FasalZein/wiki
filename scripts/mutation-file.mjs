import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Explicit plans avoid pretending that a command runner discovers affected tests.
const testCommands = new Map([
  ["packages/wiki/src/capture.ts", "node --test --test-concurrency=1 packages/wiki/test/capture-text.test.ts packages/wiki/test/capture-cli.test.ts packages/wiki/test/capture-pdf.test.ts packages/wiki/test/capture-web.test.ts packages/wiki/test/concurrent-writers.test.ts"],
  ["packages/wiki/src/update.ts", "node --test --test-concurrency=1 packages/wiki/test/update.test.ts packages/wiki/test/concurrent-writers.test.ts"],
  ["packages/wiki/src/charset.ts", "node --test --test-concurrency=1 packages/wiki/test/capture-web.test.ts"],
  ["packages/wiki/src/extract-process.ts", "node --test --test-concurrency=1 packages/wiki/test/capture-pdf.test.ts packages/wiki/test/capture-web.test.ts"],
  ["packages/wiki/src/html.ts", "node --test --test-concurrency=1 packages/wiki/test/html.test.ts packages/wiki/test/capture-web.test.ts"],
  ["packages/wiki/src/pdf.ts", "node --test --test-concurrency=1 --test-name-pattern='wiki:15|PDF|pdftotext' packages/wiki/test/capture-pdf.test.ts packages/wiki/test/capture-web.test.ts"],
  ["packages/wiki/src/web.ts", "node --test --test-concurrency=1 packages/wiki/test/capture-web.test.ts"],
  ["packages/wiki/src/paths.ts", "node --test --test-concurrency=1 packages/wiki/test/links-paths.test.ts packages/wiki/test/update.test.ts packages/wiki/test/capture-cli.test.ts"],
  ["packages/wiki/src/mutation.ts", "node --test --test-concurrency=1 packages/wiki/test/concurrent-writers.test.ts packages/wiki/test/write-boundaries.test.ts packages/wiki/test/update.test.ts packages/wiki/test/capture-cli.test.ts"],
  ["packages/wiki/src/vault.ts", "node --test --test-concurrency=1 packages/wiki/test/init.test.ts packages/wiki/test/write-boundaries.test.ts packages/wiki/test/capture-cli.test.ts packages/wiki/test/update.test.ts"],
  ["packages/wiki/src/create.ts", "node --test --test-concurrency=1 packages/wiki/test/create.test.ts packages/wiki/test/write-boundaries.test.ts packages/wiki/test/capture-cli.test.ts packages/wiki/test/update.test.ts"],
  ["src/cli/output.ts", "bun test tests/cli-links.test.ts tests/cli-search.test.ts"],
  ["packages/wiki-cli/src/cli.ts", "node --test --test-concurrency=1 packages/wiki-cli/test/cli.test.ts packages/wiki-cli/test/capture-sources.test.ts"],
]);

// Reserve the coordinator plus seven processes per worker: Stryker worker,
// command shell, test launcher, Node test-file child, CLI child, and up to two
// CLI descendants (for example the Git wrapper and Git in the Node tests).
const processesPerWorker = 7;
const coordinatorProcesses = 1;
const requiredCpus = coordinatorProcesses + processesPerWorker;

/** @param {string | undefined} target @param {NodeJS.ProcessEnv} env */
export function mutationOptions(target, env) {
  const command = target === undefined ? undefined : testCommands.get(target);
  if (command === undefined) {
    throw new Error("Unsupported mutation target. Supported exact paths: " + [...testCommands.keys()].join(", ") + ". JSON schemas and targets without an affected-test plan are not supported.");
  }
  const cpus = Number(env.HEAVY_CPUS);
  if (!Number.isSafeInteger(cpus) || cpus < requiredCpus) {
    throw new Error("HEAVY_CPUS must admit at least " + requiredCpus + " CPUs. Run bun run mutation:file outside heavy, or reserve enough outer heavy slots; no nested admission is attempted.");
  }
  const outputDir = "reports/mutation/" + target;
  return {
    mutate: [target],
    testRunner: "command",
    commandRunner: { command },
    coverageAnalysis: "off",
    concurrency: Math.floor((cpus - coordinatorProcesses) / processesPerWorker),
    // The command runner cannot track test-file changes. Discard this cache when
    // tests, collaborators, dependencies, or the plan change (see tooling docs).
    incremental: true,
    incrementalFile: outputDir + "/incremental.json",
    reporters: ["clear-text", "progress", "json", "html"],
    jsonReporter: { fileName: outputDir + "/mutation.json" },
    htmlReporter: { fileName: outputDir + "/mutation.html" },
    inPlace: false,
    // The .git worktree file and installed legacy dist must not enter sandboxes.
    ignorePatterns: ["/dist", "/archive", "/reference", "/.ralph", "/.wiki"],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: bun run mutation:file <exact-production-path>");
    const target = process.argv[2];
    // Validate before admission, then validate the actual CPU grant in config.
    mutationOptions(target, { HEAVY_CPUS: String(requiredCpus) });
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    let command;
    let args;
    if (!process.env.HEAVY_SLOT) {
      command = "heavy";
      // heavy grants at least two CPUs per slot. Claim the whole tree once.
      args = ["--slots", String(Math.ceil(requiredCpus / 2)), "--", process.execPath, fileURLToPath(import.meta.url), target];
    } else {
      mutationOptions(target, process.env);
      command = process.execPath;
      args = [fileURLToPath(new URL("../node_modules/@stryker-mutator/core/bin/stryker.js", import.meta.url)), "run", "stryker.config.mjs"];
    }
    const child = spawnSync(command, args, {
      cwd, stdio: "inherit", env: { ...process.env, WIKI_MUTATION_TARGET: target },
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
