import { dirname, join, resolve } from "node:path";

import { repairDuplicateIds, runDoctor, listVaultProjects } from "../../bootstrap/doctor";
import { applyFmtFixes } from "./fmt";
import { loadStructure } from "../../artifacts/registry";
import { projectPath } from "../../artifacts/paths";
import { evaluateSetup, type CaptureReach } from "../../bootstrap/setup-doctor";
import { anyHookWired, unreachableSubagents } from "./hooks";
import { initVault } from "../../bootstrap/init";
import { parseCommand } from "../parse";
import { unknownMessage } from "../usage";
import { emitJson, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";

export async function handleVault(args: string[]): Promise<CliResult> {
  const [action, ...rest] = args;
  if (action === "init") {
    return vaultInit(rest);
  }
  if (action === "doctor") {
    return vaultDoctor(rest);
  }
  console.error(unknownMessage("vault action", action ?? "", ["init", "doctor"]));
  return { code: 1 };
}

async function vaultInit(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, []);
  const rawPath = parsed.positionals[0];
  if (rawPath === undefined) {
    console.error("missing required argument: path");
    return { code: 1 };
  }

  const vaultPath = resolve(rawPath);
  const result = await initVault(vaultPath);

  if (jsonEnabled()) {
    emitJson({ path: vaultPath, created: result.created, skipped: result.skipped });
    return { code: 0 };
  }

  if (result.created.length > 0) {
    console.log("created:");
    for (const item of result.created) {
      console.log(`  ${item}`);
    }
  }
  if (result.skipped.length > 0) {
    console.log("skipped (already existed):");
    for (const item of result.skipped) {
      console.log(`  ${item}`);
    }
  }

  return { code: 0 };
}

async function vaultDoctor(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, [], [], ["setup", "fix"]);
  if (parsed.values.setup === true) return setupDoctor();
  const rawPath = parsed.positionals[0] ?? ".";
  const vaultPath = resolve(rawPath);

  if (parsed.values.fix === true) return vaultDoctorFix(vaultPath);

  const result = await runDoctor(vaultPath);

  if (jsonEnabled()) {
    emitJson({ vault: vaultPath, clean: result.clean, issues: result.issues });
    return { code: result.clean ? 0 : 1 };
  }

  if (result.clean) {
    console.log("vault is clean — no drift detected");
    return { code: 0 };
  }

  console.log(`found ${result.issues.length} issue(s):\n`);
  for (const issue of result.issues) {
    console.log(`  [${issue.type}] ${issue.message}`);
  }

  return { code: 1 };
}

/**
 * `wiki doctor --fix` — repair what is mechanically repairable, then re-audit
 * (SLICE-0122). Per project: renumber duplicate ids (canonical keeps the id, the
 * rest get a fresh id in the section's id-space) FIRST, then run the fmt fix
 * pipeline (legacy-id renumber with vault-wide link rewrite, rename-to-id-slug,
 * and the per-file category fixes) so the renamed/renumbered world is consistent.
 * A final `runDoctor` reports any drift `--fix` cannot auto-repair (e.g. dangling
 * links, repo bindings); a second `--fix` run is a no-op (idempotent).
 */
async function vaultDoctorFix(vaultPath: string): Promise<CliResult> {
  const structure = await loadStructure(vaultPath);
  let changed = 0;
  const renumbered: { from: string; to: string }[] = [];
  const json = jsonEnabled();
  for (const project of await listVaultProjects(vaultPath)) {
    const repair = await repairDuplicateIds(vaultPath, project, structure);
    changed += repair.reassigned;
    if (!json) for (const label of repair.labels) console.log(`fixed ${label}`);

    const fmt = await applyFmtFixes(vaultPath, projectPath(vaultPath, project), true, structure);
    changed += fmt.total;
    for (const [oldId, newId] of fmt.renumberMap) renumbered.push({ from: oldId, to: newId });
    if (!json) {
      for (const label of fmt.labels) console.log(`fixed ${label}`);
      if (fmt.renumberMap.size > 0) {
        for (const [oldId, newId] of fmt.renumberMap) console.log(`  renumbered ${oldId} -> ${newId}`);
      }
      if (fmt.manual.length > 0) {
        console.log(`${project}: needs manual attention:`);
        for (const finding of fmt.manual) console.log(`  ${finding}`);
      }
    }
  }

  if (!json && changed > 0) console.log(`applied ${changed} fix(es)`);

  const result = await runDoctor(vaultPath);
  if (json) {
    emitJson({ vault: vaultPath, fixed: changed, renumbered, clean: result.clean, remaining: result.issues });
    return { code: result.clean ? 0 : 1 };
  }
  if (result.clean) {
    console.log("vault is clean — no drift detected");
    return { code: 0 };
  }
  console.log(`${result.issues.length} issue(s) remain (manual fix needed):\n`);
  for (const issue of result.issues) {
    console.log(`  [${issue.type}] ${issue.message}`);
  }
  return { code: 1 };
}

/**
 * `wiki doctor --setup` — distribution health (binary freshness, skill-bundle
 * presence, hook install state), distinct from vault-content drift. Resolves the
 * facts from the running bundle: the repo root is two dirs above the entry
 * (dist/cli.js or src/cli.ts), so the same wiring serves dev and a built binary.
 */
async function setupDoctor(): Promise<CliResult> {
  const binaryPath = Bun.main;
  const repoRoot = dirname(dirname(binaryPath));
  const result = await evaluateSetup({
    binaryPath,
    srcDir: join(repoRoot, "src"),
    skillBundlePath: join(repoRoot, "skills", "wiki", "SKILL.md"),
    hookWired: await anyHookWired(),
    unreachableSubagents: await unreachableSubagents(),
  });

  if (jsonEnabled()) {
    emitJson({ clean: result.clean, issues: result.issues, captureReach: result.captureReach });
    return { code: result.clean ? 0 : 1 };
  }

  if (result.clean) {
    console.log("setup is healthy — binary fresh, skill bundle present, hook wired");
    printCaptureReach(result.captureReach);
    return { code: 0 };
  }

  console.log(`found ${result.issues.length} setup issue(s):\n`);
  for (const issue of result.issues) {
    console.log(`  [${issue.type}] ${issue.message}`);
  }
  printCaptureReach(result.captureReach);
  return { code: 1 };
}

/**
 * Print the per-harness capture reach so a green setup never implies non-Pi
 * subagents capture to the vault. Pi is checkable; Codex/Claude are 'unverified'
 * (ADR-0043, not run). Honest reporting only — does not affect the exit code.
 */
function printCaptureReach(reach: CaptureReach[]): void {
  console.log("\ncapture reach (per harness):");
  for (const r of reach) {
    console.log(`  [${r.status}] ${r.harness} — ${r.detail}`);
  }
}
