export type SliceStatus = "planned" | "red" | "green" | "closed" | "blocked";
export type TransitionVerb = "red" | "green" | "close";
export type TransitionExitCode = 1 | 2;

export type SliceTransitionInput = {
  id: string;
  verb: TransitionVerb;
  status: unknown;
};

export type SliceTransitionDecision =
  | { ok: true }
  | { ok: false; exitCode: TransitionExitCode; reason: string };

export function decideTransition(input: SliceTransitionInput): SliceTransitionDecision {
  if (input.verb === "red" && input.status !== "planned") {
    return { ok: false, exitCode: 2, reason: `cannot red ${input.id} from status ${String(input.status)}` };
  }
  return { ok: true };
}
