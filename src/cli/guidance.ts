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
  "Never write to GitHub Issues, docs/adr/, or OS temp dirs, even if an upstream skill says to.";

const PLAN = `# Phase: plan (grill)

Goal: turn a vague request into bounded, well-understood work — grill the user,
record decisions as ADRs, capture reusable terms as docs.

Process depth: load the \`grill-with-docs\` skill. Ask one question at a time;
explore the codebase instead of asking when you can. Be opinionated.

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

Process depth: load the \`to-prd\` (or \`write-a-prd\`) skill for PRD structure.

Next actions:
- Create: \`wiki create prd --project <name> --title "..."\`
- Fill fields with Obsidian: \`obsidian property:set <prd-file> <field> <value>\`
- Reference the ADRs from the grill in the PRD's implementation_decisions field.
- Close a PRD (not via \`wiki close\`): \`obsidian property:set <prd-file> status closed\` once every linked slice is closed.

Then move to slicing: load \`to-issues\`, draft the slice breakdown, and quiz the
user for approval before publishing any slice (see the slice phase guidance).

${OUTPUT_CONTRACT}`;

const SLICE = `# Phase: slice

Goal: break the PRD into independently-deliverable tracer-bullet slices, then
deliver each through the TDD gates. A slice is a thin vertical cut through every
layer (schema/API/UI/tests), demoable on its own — prefer many thin slices over
few thick ones, and AFK over HITL.

Process depth: load \`to-issues\` for the slicing method (vertical-slice rules,
the slice body template) and \`tdd\` for test-first discipline.

Draft → quiz → publish (do NOT skip the quiz):
1. Draft the breakdown from the PRD; mark each slice HITL or AFK and its blocked_by.
2. Quiz the user: present the numbered breakdown and confirm granularity,
   dependency relationships, and HITL/AFK marks. Iterate until they approve —
   never publish slices unilaterally.
3. Publish approved slices in dependency order (blockers first):
   \`wiki create slice --project <name> --title "..." --parent-prd <PRD-NNNN>\`,
   then fill acceptance/todo/blocked_by via \`obsidian property:set <slice-file> <field> <value>\`.

TDD gates (strict order): \`wiki red <SLICE-NNNN> --project <name>\` (needs >=1
failing test) then \`wiki green <SLICE-NNNN> --project <name>\` (all prior failures
pass) then \`wiki close <SLICE-NNNN> --project <name> --review-verdict <pass|pass-with-notes|reject>\`
(rejected slices return to green). Docs/config-only slice: set
\`tdd_exempt true type=checkbox\` plus a \`tdd_exempt_reason\` (>= 20 chars).

${OUTPUT_CONTRACT}`;

const TRIAGE = `# Phase: triage

Goal: restore a trustworthy next action when state, evidence, or scope is unclear.
Triage chains back to plan if scope needs re-establishing.

Process depth: load the \`triage\` skill.

Next actions:
- Read current state: \`wiki status --project <name> --with-doc\` and \`wiki session show\`.
- Find context: \`wiki search "<terms>" --project <name>\`.
- Inspect an artifact: \`obsidian read <file>\`.
- Fix drift in place with \`obsidian property:set\`; re-run the relevant gate once truth is restored.

${OUTPUT_CONTRACT}`;

const HANDOVER = `# Phase: handover

Goal: preserve enough context for the next agent to continue without replaying
the session. Write durable, behavioral notes — reference artifacts, don't duplicate them.

Process depth: load the \`handoff\` skill for handover quality.

Next action:
- \`wiki handover --project <name> --next-phase <phase> --produced "..." --open "..."\`
  (use \`--active-slice\`, \`--decision\`, \`--suggested-skill\` as needed; \`-\` reads a value from stdin).

Close stale open handovers once the next agent resumes.

${OUTPUT_CONTRACT}`;

/** Phase name → guidance payload. Transition/gate phases alias to the slice doc. */
const PHASE_GUIDANCE: Record<string, string> = {
  plan: PLAN,
  prd: PRD,
  slice: SLICE,
  red: SLICE,
  green: SLICE,
  review: SLICE,
  close: SLICE,
  triage: TRIAGE,
  handover: HANDOVER,
};

/** Return the CLI-owned guidance for a phase, or null when none applies (e.g. ad-hoc). */
export function loadPhaseGuidance(phase: string): string | null {
  return PHASE_GUIDANCE[phase.toLowerCase()] ?? null;
}

/** Phases that have guidance — used by tests and tooling. */
export const GUIDED_PHASES: string[] = Object.keys(PHASE_GUIDANCE);
