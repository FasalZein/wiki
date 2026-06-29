import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repairDuplicateIds } from "../src/bootstrap/doctor";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// SLICE-0122: `wiki doctor --fix` repairs duplicate ids (canonical keeps the id,
// the rest are renumbered in the section id-space) and the mechanical drift that
// `fmt --write` fixes (legacy-id renumber with vault-wide [[id]] link rewrite,
// rename-to-id-slug). Detect-only `doctor` never writes. A second --fix is a no-op.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wiki-doctorfix-"));
  tempPaths.push(root);
  return join(root, "vault");
}

async function writeArtifact(vaultRoot: string, project: string, folder: string, filename: string, body: string): Promise<void> {
  const dir = join(vaultRoot, "projects", project, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), body);
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function prdFiles(vaultRoot: string, project: string): Promise<string[]> {
  return (await readdir(join(vaultRoot, "projects", project, "prds"))).sort();
}

describe("repairDuplicateIds (unit)", () => {
  test("keeps the canonical file's id and renumbers the duplicate in the section id-space", async () => {
    const vaultRoot = await makeVault();
    // Two PRD-0005 files; the lexicographically-first path is canonical.
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0005-a.md", "---\nid: PRD-0005\naliases:\n  - PRD-0005\ntitle: Alpha\n---\n# Alpha\n");
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0005-b.md", "---\nid: PRD-0005\naliases:\n  - PRD-0005\ntitle: Beta\n---\n# Beta references [[PRD-0005]] itself.\n");

    const repair = await repairDuplicateIds(vaultRoot, "demo", DEFAULT_STRUCTURE);

    expect(repair.reassigned).toBe(1);
    const files = await prdFiles(vaultRoot, "demo");
    // canonical keeps PRD-0005; the duplicate is renumbered to the next free id (PRD-0006).
    const canonical = await readFile(join(vaultRoot, "projects", "demo", "prds", "PRD-0005-a.md"), "utf8");
    expect(canonical).toContain("id: PRD-0005");
    const reassignedName = files.find((f) => f.startsWith("PRD-0006"));
    expect(reassignedName).toBeDefined();
    const reassigned = await readFile(join(vaultRoot, "projects", "demo", "prds", reassignedName!), "utf8");
    expect(reassigned).toContain("id: PRD-0006");
    expect(reassigned).toContain("- PRD-0006"); // alias rewritten
    expect(reassigned).not.toContain("id: PRD-0005");
    // self-referential [[PRD-0005]] in the reassigned file now points to its new id.
    expect(reassigned).toContain("[[PRD-0006]]");
    // the old duplicate file name is gone.
    expect(files).not.toContain("PRD-0005-b.md");
  });

  test("is a no-op when every id is unique", async () => {
    const vaultRoot = await makeVault();
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0001-a.md", "---\nid: PRD-0001\ntitle: A\n---\n# A\n");
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0002-b.md", "---\nid: PRD-0002\ntitle: B\n---\n# B\n");

    const repair = await repairDuplicateIds(vaultRoot, "demo", DEFAULT_STRUCTURE);
    expect(repair.reassigned).toBe(0);
  });
});

describe("wiki doctor --fix (end-to-end)", () => {
  test("doctor WITHOUT --fix is detect-only — reports the duplicate and writes nothing", async () => {
    const vaultRoot = await makeVault();
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0005-a.md", "---\nid: PRD-0005\ntitle: A\n---\n# A\n");
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0005-b.md", "---\nid: PRD-0005\ntitle: B\n---\n# B\n");

    const result = await runWiki(["doctor", vaultRoot], vaultRoot);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("duplicate-id");
    // no write happened: both files still carry PRD-0005.
    const files = await prdFiles(vaultRoot, "demo");
    expect(files).toContain("PRD-0005-a.md");
    expect(files).toContain("PRD-0005-b.md");
  });

  test("--fix repairs the duplicate id and rewrites a legacy-id inbound [[link]] vault-wide; a second run is a no-op", async () => {
    const vaultRoot = await makeVault();
    // A duplicate-id pair.
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0005-a.md", "---\nid: PRD-0005\naliases:\n  - PRD-0005\ntitle: A\n---\n# A\n");
    await writeArtifact(vaultRoot, "demo", "prds", "PRD-0005-b.md", "---\nid: PRD-0005\naliases:\n  - PRD-0005\ntitle: B\n---\n# B\n");
    // A legacy 3-digit id plus an inbound [[link]] from another file — exercises the
    // fmt renumber + vault-wide reference rewrite that --fix drives.
    await writeArtifact(vaultRoot, "demo", "slices", "SLICE-001-legacy.md", "---\nid: SLICE-001\naliases:\n  - SLICE-001\ntitle: Legacy slice\n---\n# Legacy\n");
    await writeArtifact(vaultRoot, "demo", "slices", "SLICE-0042-ref.md", "---\nid: SLICE-0042\ntitle: Refs legacy\n---\n# Depends on SLICE-001.\n");

    const fix = await runWiki(["doctor", vaultRoot, "--fix"], vaultRoot);
    expect(fix.exitCode).toBe(0);

    // Duplicate repaired: distinct PRD ids on disk.
    const prds = await prdFiles(vaultRoot, "demo");
    expect(prds.some((f) => f.startsWith("PRD-0005"))).toBe(true);
    expect(prds.some((f) => f.startsWith("PRD-0006"))).toBe(true);

    // Legacy id renumbered SLICE-001 -> SLICE-0001 and the inbound reference rewritten.
    const sliceNames = (await readdir(join(vaultRoot, "projects", "demo", "slices"))).sort();
    const refName = sliceNames.find((f) => f.startsWith("SLICE-0042"));
    expect(refName).toBeDefined();
    const ref = await readFile(join(vaultRoot, "projects", "demo", "slices", refName!), "utf8");
    expect(ref).toContain("SLICE-0001");
    expect(ref).not.toContain("SLICE-001.");

    // Idempotent: re-running --fix changes nothing and reports clean.
    const again = await runWiki(["doctor", vaultRoot, "--fix"], vaultRoot);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("clean");
    const prdsAfter = await prdFiles(vaultRoot, "demo");
    expect(prdsAfter.sort()).toEqual(prds.sort());
  });
});
