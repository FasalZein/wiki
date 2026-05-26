import { handleDecision } from "./verbs/decision";
import { handleHandover } from "./verbs/handover";
import { handleLock } from "./verbs/lock";
import { handlePhase } from "./verbs/phase";
import { handlePlan } from "./verbs/plan";
import { handlePrd } from "./verbs/prd";
import { handleProject } from "./verbs/project";
import { handleSearch } from "./verbs/search";
import { handleSession } from "./verbs/session";
import { handleSlice } from "./verbs/slice";
import { handleStatus } from "./verbs/status";
import { handleSync } from "./verbs/sync";
import { handleTerm } from "./verbs/term";
import { handleVault } from "./verbs/vault";

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
  if (verb === "lock") {
    return handleLock(rest);
  }
  if (verb === "phase") {
    return handlePhase(rest);
  }
  if (verb === "plan") {
    return handlePlan(rest);
  }
  if (verb === "prd") {
    return handlePrd(rest);
  }
  if (verb === "project") {
    return handleProject(rest);
  }
  if (verb === "search") {
    return handleSearch(rest);
  }
  if (verb === "session") {
    return handleSession(rest);
  }
  if (verb === "slice") {
    return handleSlice(rest);
  }
  if (verb === "status") {
    return handleStatus(rest);
  }
  if (verb === "sync") {
    return handleSync(rest);
  }
  if (verb === "term") {
    return handleTerm(rest);
  }
  if (verb === "vault") {
    return handleVault(rest);
  }
  console.error(`unknown verb: ${verb ?? ""}`.trim());
  return { code: 1 };
}
