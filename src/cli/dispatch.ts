import { handleDecision } from "./verbs/decision";
import { handleHandover } from "./verbs/handover";
import { handlePlan } from "./verbs/plan";
import { handlePrd } from "./verbs/prd";
import { handleSlice } from "./verbs/slice";
import { handleTerm } from "./verbs/term";

export type CliResult = {
  code: number;
};

export async function dispatch(args: string[]): Promise<CliResult> {
  const [verb, ...rest] = args;
  if (verb === "decision") {
    return handleDecision(rest);
  }
  if (verb === "handover") {
    return handleHandover(rest);
  }
  if (verb === "plan") {
    return handlePlan(rest);
  }
  if (verb === "prd") {
    return handlePrd(rest);
  }
  if (verb === "slice") {
    return handleSlice(rest);
  }
  if (verb === "term") {
    return handleTerm(rest);
  }
  console.error(`unknown verb: ${verb ?? ""}`.trim());
  return { code: 1 };
}
