import { handleDecision } from "./verbs/decision";

export type CliResult = {
  code: number;
};

export async function dispatch(args: string[]): Promise<CliResult> {
  const [verb, ...rest] = args;
  if (verb === "decision") {
    return handleDecision(rest);
  }
  console.error(`unknown verb: ${verb ?? ""}`.trim());
  return { code: 1 };
}
