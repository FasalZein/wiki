/**
 * CLI-owned phase guidance (ADR-0024, ADR-0026).
 *
 * This is the single source of the inline guidance that `wiki status --with-doc`
 * and the create/handover auto-doc print at the moment of action. It replaces
 * the forked PHASE-*.md skill files (SLICE-0040): instead of duplicating Matt
 * Pocock's upstream process discipline, each entry carries only the slim,
 * task-conditioned payload — the immediate next commands, where output goes, the
 * hard output contract, and a pointer to the upstream skill for process depth.
 *
 * Keep entries short. Per DOC-0002 the lever is selection clarity + moment-of-
 * action guidance, not a re-hosted manual. Process depth belongs upstream.
 */

/** The output contract every phase reprints — the integration seam from ADR-0026. */
const OUTPUT_CONTRACT =
  "Output contract: every artifact write goes through the wiki CLI into the vault. " +
  "Never write to GitHub Issues, docs/adr/, a repo CONTEXT.md, or OS temp dirs, even if an upstream skill says to. " +
  "Creation is one-shot: pass the authored body with `--body -` — never `obsidian create`.";

const PLAN = `# Phase: plan (grill)

Goal: turn a vague request into bounded, well-understood work — grill the user,
record decisions as ADRs, capture reusable terms as docs.

Process depth: load the \`grill-with-docs\` skill. Ask one question at a time;
explore the codebase instead of asking when you can. Be opinionated.

Heads-up: \`grill-with-docs\` tells you to write \`CONTEXT.md\` and \`docs/adr/\` in
the repo — don't. The vault is the glossary: terms go to \`wiki create doc --type reference\`,
trade-offs to \`wiki create decision\`.

Next actions:
- Record a non-trivial trade-off: \`wiki create decision --project <name> --title "..." --context "..." --decision "..." --consequences "..."\`
- Capture a reusable term/context: \`wiki create doc --project <name> --title "..." --type reference\`
- When scope is bounded and ADRs are recorded, promote: \`wiki create prd --project <name> --title "..."\`

Offer an ADR only when all three hold: hard to reverse, surprising without
context, a real trade-off existed.

${OUTPUT_CONTRACT}`;

const PRD = `# Phase: prd

Goal: create or refine a product requirement that can drive slices, implementing
the decisions from the grill.

Method (vault-native — no upstream skill needed):
1. Clarify the goal: synthesize what you already know; do NOT interview the user —
   explore the codebase instead when in doubt.
2. Sketch testable seams: prefer existing seams over new ones; use the highest
   seam possible. Check with the user that the seams match their expectations.
3. Structure the PRD body: problem statement, solution, user stories (extensive
   numbered list covering all aspects), implementation decisions, testing decisions,
   out-of-scope, further notes. Use the project's domain glossary and respect ADRs.

Next actions:
- Create with the full authored body in one command (H2 sections fill the template):
  \`cat prd-body.md | wiki create prd --project <name> --title "..." --body -\`
  See \`wiki create prd --help\` for the expected sections. Never \`obsidian create\`.
- Reference the ADRs from the grill in the body's Implementation Decisions section.
- Later field edits use Obsidian: \`obsidian property:set <prd-file> <field> <value>\`.
- Close a PRD (not via \`wiki close\`): \`obsidian property:set <prd-file> status closed\` once every linked slice is closed.

Then move to slicing: load the \`to-slices\` skill and follow its draft → quiz →
publish flow (see the slice phase guidance).

${OUTPUT_CONTRACT}`;

const SLICE = `# Phase: slice

Goal: break the PRD into independently-deliverable tracer-bullet slices, then
deliver each through the TDD gates. A slice is a thin vertical cut through every
layer (schema/API/UI/tests), demoable on its own — prefer many thin slices over
few thick ones, and AFK over HITL.

Process depth: load the \`to-slices\` skill for the slicing method (vertical-slice
rules, draft → quiz → publish flow) and \`tdd\` for test-first discipline.

Draft → quiz → publish (do NOT skip the quiz):
1. Draft the breakdown from the PRD; mark each slice HITL or AFK and its blocked_by.
2. Quiz the user: present the numbered breakdown and confirm granularity,
   dependency relationships, and HITL/AFK marks. Iterate until they approve —
   never publish slices unilaterally.
3. Publish approved slices in dependency order (blockers first), one command each:
   \`wiki create slice --project <name> --title "..." --parent-prd <PRD-NNNN> --acceptance "..." --acceptance "..." --body -\`
   (\`--body -\` reads the "## What to build" section from stdin; never \`obsidian create\`).
   Set \`blocked_by\` after blockers exist via \`obsidian eval\` with
   \`app.fileManager.processFrontMatter\` (\`property:set type=list\` corrupts comma values).

TDD gates (strict order): \`wiki red <SLICE-NNNN> --project <name>\` (needs >=1
failing test) then \`wiki green <SLICE-NNNN> --project <name>\` (all prior failures
pass) then \`wiki close <SLICE-NNNN> --project <name> --review-verdict <pass|pass-with-notes|reject>\`
(rejected slices return to green). Docs/config-only slice: set
\`tdd_exempt true type=checkbox\` plus a \`tdd_exempt_reason\` (>= 20 chars).

How \`tdd\` micro-cycles fit the gates: \`wiki red\` captures the first tracer
failure, the test/implement micro-cycles run between the gates, \`wiki green\`
seals the whole suite. After a frontmatter write, \`obsidian property:read\` may
serve a stale cached value — verify with \`obsidian read <file>\`, don't re-write.

${OUTPUT_CONTRACT}`;

const TRIAGE = `# Phase: triage

Goal: restore a trustworthy next action when state, evidence, or scope is unclear.

Method (vault-native — no upstream skill needed):
1. Re-establish ground truth: \`wiki status --project <name> --with-doc\`,
   \`wiki session show\`, and \`wiki doctor\` — trust the vault over your memory of it.
2. Recall context: \`wiki search "<terms>" --project <name>\`; inspect artifacts
   with \`obsidian read <file>\`. Resolve by frontmatter ID, not filename.
3. Fix drift in place: \`obsidian property:set\` for scalar fields, comma-safe
   \`obsidian eval\` with \`app.fileManager.processFrontMatter\` for lists. Never
   delete-and-recreate an artifact to escape a confusing state.
4. Re-run the relevant gate once truth is restored. If scope itself is unclear,
   chain back to plan: \`wiki session set phase plan\`.

${OUTPUT_CONTRACT}`;

const HANDOVER = `# Phase: handover

Goal: preserve enough context for the next agent to continue without replaying
the session. Write durable, behavioral notes — reference artifacts, don't duplicate them.

Process depth: load the \`handoff\` skill for handover quality.

Next action:
- \`wiki handover --project <name> --next-phase <phase> --produced "..." --open "..."\`
  (use \`--active-slice\`, \`--decision\`, \`--suggested-skill\` as needed; \`-\` reads a value from stdin).

Close stale open handovers once the next agent resumes.

Sync before you hand off: once all writes for this session are done, run
\`wiki sync --project <name>\` (add \`--include-research\` if relevant) so semantic
search reflects them. \`wiki search\` auto-updates the index but does NOT re-embed,
so new/edited artifacts stay invisible to ranked search until a sync.

${OUTPUT_CONTRACT}`;

const AD_HOC = `# Phase: ad-hoc

You are in an ad-hoc session: no workflow phase is set, so there is no enforced
next step. This is the default for a freshly started session.

To enter the delivery workflow, set a phase, then rerun \`wiki status --with-doc\`:
- \`wiki session set phase plan\` — fuzzy scope, multiple approaches (grill first).
- \`wiki session set phase prd\` — scope is clear; write the requirement.
- \`wiki session set phase slice\` — a PRD exists; break it into slices and deliver.
- \`wiki session set phase triage\` — state is unclear; restore a trustworthy next step.
(You can also pass \`--phase <phase>\` to \`wiki session start\` up front.)

Ad-hoc is fine for one-off reads, searches, or admin (\`wiki search\`, \`wiki doctor\`,
\`wiki vault --help\`). Set a phase only when you are doing delivery work.

${OUTPUT_CONTRACT}`;

/**
 * One phase model = the single place phase behavior lives. Previously the guidance
 * payload, the upstream-skill list, and the next-action text were three separate maps
 * (the third inlined in status.ts), so adding or renaming a phase meant coordinated
 * edits in several files. Now each phase is one entry: guidance + skills + next-action.
 * Transition/gate phases (red/green/review/close) share the slice guidance + skills but
 * keep their own next-action. The CLI EMITS skill names for the agent to load; it never
 * reads or executes skill files (ADR-0024/0026). The payload prose and skills/wiki/SKILL.md
 * remain human-facing restatements pinned to this model by tests (skill-bundle.test.ts).
 */
export type NextActionContext = { project: string; slice: string; prd?: string };

type PhaseModel = {
  guidance: string;
  skills: string[];
  nextAction: (ctx: NextActionContext) => string;
};

const SLICE_SKILLS = ["to-slices", "tdd"];
// nextAction returns a literal, copy-pasteable command (SLICE-0063) — no "run "/prose prefix,
// no bare "...". Genuinely-unknown values (titles, criteria) are angle-bracket placeholders.
const closeNext = ({ project, slice }: NextActionContext): string =>
  `wiki close ${slice} --project ${project} --review-verdict pass`;

const PHASES: Record<string, PhaseModel> = {
  plan: { guidance: PLAN, skills: ["grill-with-docs"], nextAction: ({ project }) => `wiki create prd --project ${project} --title "<title>"` },
  prd: { guidance: PRD, skills: [], nextAction: ({ project, prd }) => `wiki create slice --project ${project} --parent-prd ${prd ?? "<PRD-NNNN>"} --title "<title>" --acceptance "<criterion>"` },
  slice: { guidance: SLICE, skills: SLICE_SKILLS, nextAction: ({ project, slice }) => `wiki red ${slice} --project ${project}` },
  red: { guidance: SLICE, skills: SLICE_SKILLS, nextAction: ({ project, slice }) => `wiki green ${slice} --project ${project}` },
  green: { guidance: SLICE, skills: SLICE_SKILLS, nextAction: closeNext },
  review: { guidance: SLICE, skills: SLICE_SKILLS, nextAction: closeNext },
  close: { guidance: SLICE, skills: SLICE_SKILLS, nextAction: closeNext },
  triage: { guidance: TRIAGE, skills: [], nextAction: () => "no enforced next step" },
  handover: { guidance: HANDOVER, skills: ["handoff"], nextAction: ({ project }) => `wiki handover --project ${project} --next-phase <phase>` },
  "ad-hoc": { guidance: AD_HOC, skills: [], nextAction: () => "set a phase to begin: wiki session set phase <plan|prd|slice|triage>, then rerun wiki status --with-doc" },
};

/** Return the CLI-owned guidance for a phase, or null when the phase is genuinely unmapped. */
export function loadPhaseGuidance(phase: string): string | null {
  return PHASES[phase.toLowerCase()]?.guidance ?? null;
}

/** Phases that have guidance — used by tests and tooling. */
export const GUIDED_PHASES: string[] = Object.keys(PHASES);

/** The upstream skill(s) the agent should load for a phase. Empty when none applies. */
export function skillsForPhase(phase: string): string[] {
  return PHASES[phase.toLowerCase()]?.skills ?? [];
}

/** The enforced next step for a phase given runtime context; default when unmapped. */
export function nextActionForPhase(phase: string, ctx: NextActionContext): string {
  return PHASES[phase.toLowerCase()]?.nextAction(ctx) ?? "no enforced next step";
}
