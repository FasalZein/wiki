import { handleDecision } from "./verbs/decision";
import { handlePrd } from "./verbs/prd";
import { handleSlice } from "./verbs/slice";

export type CliResult = {
  code: number;
};

export async function dispatch(args: string[]): Promise<CliResult> {
  const [verb, ...rest] = args;
  if (verb === "decision") {
    return handleDecision(rest);
  }
  if (verb === "prd") {
    return handlePrd(rest);
  }
  if (verb === "slice") {
    return handleSlice(rest);
  }
  console.error(`unknown verb: ${verb ?? ""}`.trim());
  return { code: 1 };
}
