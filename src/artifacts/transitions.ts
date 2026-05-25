export type SliceStatus = "planned" | "red" | "green" | "closed" | "blocked";
export type TransitionVerb = "red" | "green" | "close";
export type TransitionExitCode = 1 | 2;

export type TodoItem = {
  id?: unknown;
  text?: unknown;
  done?: unknown;
};

export type SliceTransitionInput = {
  id: string;
  verb: TransitionVerb;
  status: unknown;
  acceptance?: unknown;
  todos?: unknown;
  tddExempt?: unknown;
  tddExemptReason?: unknown;
  capturedExitCode?: number;
};

export type SliceTransitionDecision =
  | { ok: true }
  | { ok: false; exitCode: TransitionExitCode; reason: string };

export function decideTransition(input: SliceTransitionInput): SliceTransitionDecision {
  const exempt = input.tddExempt === true;
  const reason = typeof input.tddExemptReason === "string" ? input.tddExemptReason : "";
  if (exempt && reason.length < 20) {
    return { ok: false, exitCode: 2, reason: "tdd_exempt requires tdd_exempt_reason of at least 20 characters" };
  }

  if ((input.verb === "red" || input.verb === "green") && exempt) {
    return { ok: false, exitCode: 2, reason: `${input.verb} is unavailable when tdd_exempt is true` };
  }

  if (input.verb === "red") {
    if (input.status !== "planned") {
      return { ok: false, exitCode: 2, reason: `cannot red ${input.id} from status ${String(input.status)}` };
    }
    if (!Array.isArray(input.acceptance) || input.acceptance.length === 0) {
      return { ok: false, exitCode: 1, reason: "acceptance must contain at least one item" };
    }
    if (input.capturedExitCode !== undefined && input.capturedExitCode === 0) {
      return { ok: false, exitCode: 1, reason: "no failing tests captured" };
    }
    return { ok: true };
  }

  if (input.verb === "green") {
    if (input.status !== "red") {
      return { ok: false, exitCode: 2, reason: `cannot green ${input.id} from status ${String(input.status)}` };
    }
    if (input.capturedExitCode !== undefined && input.capturedExitCode !== 0) {
      return { ok: false, exitCode: 1, reason: "tests still failing" };
    }
    return { ok: true };
  }

  if (input.status !== "green" && !(input.status === "planned" && exempt)) {
    return { ok: false, exitCode: 2, reason: `cannot close ${input.id} from status ${String(input.status)}` };
  }
  const unfinished = firstUnfinishedTodo(input.todos);
  if (unfinished !== undefined) {
    return { ok: false, exitCode: 1, reason: `unfinished todo ${unfinished.id}: ${unfinished.text}` };
  }
  return { ok: true };
}

function firstUnfinishedTodo(todos: unknown): { id: string; text: string } | undefined {
  if (!Array.isArray(todos)) {
    return undefined;
  }
  for (const [index, todo] of todos.entries()) {
    if (typeof todo === "string") {
      return { id: String(index + 1), text: todo };
    }
    if (isRecord(todo) && todo.done !== true) {
      return {
        id: typeof todo.id === "string" ? todo.id : String(index + 1),
        text: typeof todo.text === "string" ? todo.text : "",
      };
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
