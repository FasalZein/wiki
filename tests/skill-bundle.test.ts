import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPhaseDoc, renderPhaseDoc } from "../src/cli/phase-docs";
import { GUIDED_PHASES, skillsForPhase, nextActionForPhase } from "../src/cli/guidance";

const repoRoot = import.meta.dir.replace(/\/tests$/, "");
const skillDir = join(repoRoot, "skills", "wiki");

const triggerTerms = ["vault", "PRD", "slice", "decision", "TDD", "close", "handover", "init", "doctor"] as const;

describe("wiki skill bundle", () => {
  test("the skill collapses to a single SKILL.md (SLICE-0040: forked PHASE/ADMIN docs removed)", async () => {
    const entries = (await readdir(skillDir)).sort();

    expect(entries).toEqual(["SKILL.md"]);
  });

  test("SKILL.md is non-empty", async () => {
    const content = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test("SKILL.md stays within the line cap and exposes trigger terms in its description", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const lineCount = skill.split("\n").length;
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";

    expect(lineCount).toBeLessThanOrEqual(100);
    for (const term of triggerTerms) {
      expect(description).toContain(term);
    }
  });

  test("SKILL.md is a thin router: no duplicated command syntax (ADR-0025)", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");

    // No fenced code blocks restating CLI syntax.
    expect(skill).not.toContain("```");
    // No flag-bearing command syntax — the CLI owns that via `wiki <verb> --help`.
    // Inline router pointers like `wiki status --with-doc` are allowed; concrete
    // create/transition syntax with required flags is not.
    expect(skill).not.toMatch(/wiki create \w+ --\w+/);
    expect(skill).not.toMatch(/--project <name> --title/);
    // It must point the agent at the authoritative surfaces instead.
    expect(skill).toContain("wiki <verb> --help");
    expect(skill).toContain("wiki status");
    // And it must state the hard output contract (ADR-0026).
    expect(skill.toLowerCase()).toContain("output contract");
    expect(skill).toContain("vault");
  });

  test("phase guidance is CLI-owned and resolves without any forked skill files (ADR-0024)", () => {
    // The core SLICE-0040 guarantee: removing the forked PHASE-*.md files must NOT
    // blank out --with-doc / auto-doc. Guidance now lives in src/cli/guidance.ts.
    for (const phase of ["plan", "prd", "slice", "triage", "handover"]) {
      const doc = loadPhaseDoc(phase);
      expect(doc, `guidance missing for phase: ${phase}`).not.toBeNull();
      expect(doc).toContain(`# Phase: ${phase === "plan" ? "plan (grill)" : phase}`);
      // Every guided phase reprints the output contract — the integration seam.
      expect(doc?.toLowerCase()).toContain("output contract");
    }
  });

  test("transition phases alias to slice guidance; genuinely unmapped phases return null", () => {
    expect(loadPhaseDoc("green")).toContain("# Phase: slice");
    expect(loadPhaseDoc("close")).toContain("# Phase: slice");
    expect(loadPhaseDoc("nonexistent-phase")).toBeNull();
    expect(GUIDED_PHASES).toContain("plan");
    expect(GUIDED_PHASES).toContain("handover");
  });

  test("ad-hoc has bootstrap guidance so a fresh session is never a dead-end (cold-start)", () => {
    const doc = loadPhaseDoc("ad-hoc");
    expect(doc).not.toBeNull();
    expect(doc).toContain("# Phase: ad-hoc");
    expect(doc).toContain("wiki session set phase");
  });

  // --- phase→skill mapping is a first-class, pinned value (no prose/table drift) ---

  test("every guided phase (except ad-hoc and vault-native prd/triage) names at least one skill", () => {
    // prd (ADR-0030) and triage (ADR-0032) are vault-native: no upstream skill needed;
    // the method lives in the phase doc itself.
    const vaultNativePhases = new Set(["ad-hoc", "prd", "triage"]);
    for (const phase of GUIDED_PHASES) {
      const skills = skillsForPhase(phase);
      if (vaultNativePhases.has(phase)) {
        expect(skills, `vault-native phase ${phase} should have no upstream skill`).toEqual([]);
      } else {
        expect(skills.length, `phase ${phase} has no skill`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // --- SLICE-0044: vault-native prd phase + slices routing (ADR-0030) ---

  test("prd phase is vault-native: no upstream skill, guidance carries the PRD-writing method (SLICE-0044)", () => {
    expect(skillsForPhase("prd")).toEqual([]);
    const doc = loadPhaseDoc("prd") ?? "";
    expect(doc).not.toContain("`to-prd`");
    expect(doc).not.toContain("`write-a-prd`");
    // The method keywords the phase doc now carries inline.
    expect(doc).toContain("seam");
    expect(doc).toContain("user stor");
  });

  test("slice phases route to to-slices skill not to-issues (SLICE-0044)", () => {
    for (const phase of ["slice", "red", "green", "review", "close"]) {
      const skills = skillsForPhase(phase);
      expect(skills, `${phase} should include to-slices`).toContain("to-slices");
      expect(skills, `${phase} should not include to-issues`).not.toContain("to-issues");
    }
    const doc = loadPhaseDoc("slice") ?? "";
    expect(doc).toContain("`to-slices`");
    expect(doc).not.toContain("`to-issues`");
  });

  test("guidance routes to one-shot creation with --body (SLICE-0048, ADR-0031)", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("--body -");
    expect(skill.toLowerCase()).toContain("one-shot");
    expect(skill).toContain("`obsidian create` is never used");

    const prdDoc = loadPhaseDoc("prd") ?? "";
    expect(prdDoc).toContain("--body -");
    const sliceDoc = loadPhaseDoc("slice") ?? "";
    expect(sliceDoc).toContain("--acceptance");
    expect(sliceDoc).toContain("--body -");
  });

  test("contract names a repo CONTEXT.md on every surface (SLICE-0049, ADR-0032)", async () => {
    // Layer 1 prevention: grill-with-docs and improve-codebase-architecture instruct
    // agents to create a repo CONTEXT.md / docs/adr/ — every contract surface must
    // name CONTEXT.md so following them is a visible violation, not a loophole.
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("CONTEXT.md");

    for (const phase of GUIDED_PHASES) {
      const doc = loadPhaseDoc(phase) ?? "";
      expect(doc, `phase ${phase} contract omits CONTEXT.md`).toContain("CONTEXT.md");
    }

    // Plan phase names the conflict and redirects both outputs into the vault.
    const plan = loadPhaseDoc("plan") ?? "";
    expect(plan).toContain("`grill-with-docs`");
    expect(plan).toContain("wiki create doc");
    expect(plan).toContain("wiki create decision");
  });

  test("slice phase doc reconciles tdd micro-cycles with the gates and warns on property:read staleness (SLICE-0049)", () => {
    const doc = loadPhaseDoc("slice") ?? "";
    expect(doc.toLowerCase()).toContain("micro-cycle");
    expect(doc).toContain("property:read");
    expect(doc.toLowerCase()).toContain("stale");
  });

  test("each phase payload prose names exactly its skillsForPhase skills (prose pinned to map)", () => {
    for (const phase of GUIDED_PHASES) {
      if (phase === "ad-hoc") continue;
      const doc = loadPhaseDoc(phase) ?? "";
      for (const skill of skillsForPhase(phase)) {
        expect(doc, `phase ${phase} payload omits skill ${skill}`).toContain(`\`${skill}\``);
      }
    }
  });

  test("SKILL.md routing table matches skillsForPhase (table pinned to map)", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    // Parse the routing line, e.g.: plan→`grill-with-docs`, prd→`to-prd`,
    // slice/red/green→`to-issues` + `tdd`, triage→`triage`, handover→`handoff`.
    const pairs = [...skill.matchAll(/([a-z/]+)→((?:`[a-z-]+`(?:\s*\+\s*)?)+)/g)];
    expect(pairs.length, "no phase→skill routing pairs found in SKILL.md").toBeGreaterThan(0);
    for (const [, phaseGroup, skillGroup] of pairs) {
      const advertised = [...(skillGroup ?? "").matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? "");
      for (const phase of (phaseGroup ?? "").split("/")) {
        expect(skillsForPhase(phase), `SKILL.md table drift for phase ${phase}`).toEqual(advertised);
      }
    }
  });

  // --- SLICE-0051: handoff fork + triage retirement (ADR-0032 Layer 3) ---

  test("triage is vault-native: no upstream skill, phase doc carries the method (SLICE-0051, ADR-0032)", () => {
    expect(skillsForPhase("triage")).toEqual([]);
    const doc = loadPhaseDoc("triage") ?? "";
    // The retired upstream skill must not be routed to anymore.
    expect(doc).not.toContain("`triage`");
    expect(doc).not.toContain("Process depth: load");
    // Method keywords now carried inline: ground truth, recall, fix drift, chain to plan.
    expect(doc).toContain("wiki status");
    expect(doc).toContain("wiki search");
    expect(doc.toLowerCase()).toContain("drift");
    expect(doc).toContain("phase plan");
  });

  test("bundled handoff skill is a single vault-native SKILL.md with no temp-dir instruction (SLICE-0051, ADR-0032)", async () => {
    const handoffDir = join(repoRoot, "skills", "handoff");
    const entries = (await readdir(handoffDir)).sort();
    expect(entries).toEqual(["SKILL.md"]);

    const skill = await readFile(join(handoffDir, "SKILL.md"), "utf8");
    expect(skill.split("\n").length).toBeLessThanOrEqual(100);
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    expect(description.toLowerCase()).toContain("handover");
    expect(description).toContain("Use when");
    // Vault-native: publishes via wiki handover, never temp dirs or repo files.
    expect(skill).toContain("wiki handover");
    expect(skill).toContain("vault");
    expect(skill.toLowerCase()).not.toMatch(/temp (dir|directory|file)|tmpdir|\/tmp\//);
    // Thin router discipline (ADR-0025): no fenced syntax restated.
    expect(skill).not.toContain("```");
    // SLICE-0056: the CLI advances the phase and prints the resume prompt —
    // the skill relays it verbatim instead of a manual set-phase workaround.
    expect(skill).not.toContain("wiki session set phase");
    expect(skill).toContain("verbatim");
    expect(skill).toContain("next session prompt");
  });

  // --- phase model: next-action contract + renderer parity (one model, thin emitters) ---

  test("every guided phase has a non-empty next-action; ad-hoc routes to set-a-phase", () => {
    for (const phase of GUIDED_PHASES) {
      const next = nextActionForPhase(phase, { project: "demo", slice: "SLICE-0001" });
      expect(next.length, `phase ${phase} next-action`).toBeGreaterThan(0);
    }
    expect(nextActionForPhase("slice", { project: "demo", slice: "SLICE-0001" })).toBe("run wiki red SLICE-0001 --project demo");
    expect(nextActionForPhase("ad-hoc", { project: "demo", slice: "<slice>" })).toContain("set a phase");
    // genuinely unmapped phase falls back, never throws
    expect(nextActionForPhase("nope", { project: "demo", slice: "x" })).toBe("no enforced next step");
  });

  test("renderPhaseDoc is the single body source both emitters share (no drift)", () => {
    for (const phase of GUIDED_PHASES) {
      const rendered = renderPhaseDoc(phase);
      expect(rendered, `phase ${phase} render`).not.toBeNull();
      // the labeled block always contains the phase's own guidance body
      expect(rendered).toContain(`--- phase doc: ${phase} ---`);
      expect(rendered).toContain(loadPhaseDoc(phase) ?? "\u0000");
    }
    expect(renderPhaseDoc("nope")).toBeNull();
  });

  test("status --with-doc emits CLI-owned guidance after the forked files are gone", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
    const sessionPath = join(repoRoot, ".wiki", "state", "session.json");
    const existingSession = await readFile(sessionPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });

    try {
      await mkdir(join(vaultRoot, "projects", "wiki-v2"), { recursive: true });
      await writeFile(join(vaultRoot, "projects", "wiki-v2", "_project.md"), `---\nproject: wiki-v2\nrepo: ${repoRoot}\ntest_command: bun test\n---\n# wiki-v2\n`);
      await mkdir(join(repoRoot, ".wiki", "state"), { recursive: true });
      await writeFile(
        sessionPath,
        JSON.stringify({ project: "wiki-v2", phase: "slice", active_slices: [], updated: "2026-05-26T00:00:00.000Z" }, null, 2),
      );

      const result = await runWiki(["status", "--project", "wiki-v2", "--with-doc"], vaultRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--- phase doc: slice ---");
      expect(result.stdout).toContain("# Phase: slice");
      expect(result.stdout.toLowerCase()).toContain("output contract");
    } finally {
      if (existingSession === null) {
        await rm(sessionPath, { force: true });
      } else {
        await writeFile(sessionPath, existingSession);
      }
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runWiki(args: string[], vaultRoot: string): Promise<CommandResult> {
  const proc = Bun.spawn(["bun", join(repoRoot, "src", "cli.ts"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: vaultRoot, OBSIDIAN_BIN: join(import.meta.dir, "fixtures", "mock-obsidian.sh") },
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
