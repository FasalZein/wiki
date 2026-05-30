import { handleClose } from "./verbs/close";
import { handleCreate } from "./verbs/create";
import { handleDoc } from "./verbs/doc";
import { handleNextId } from "./verbs/next-id";
import { handleProject } from "./verbs/project";
import { handleRed, handleGreen } from "./verbs/tdd";
import { handleSearch } from "./verbs/search";
import { handleSession } from "./verbs/session";
import { handleStatus } from "./verbs/status";
import { handleSync } from "./verbs/sync";
import { handleValidate } from "./verbs/validate";
import { handleVault } from "./verbs/vault";

export type CliResult = {
  code: number;
};

export async function dispatch(args: string[]): Promise<CliResult> {
  const [verb, ...rest] = args;
  if (verb === "create") return handleCreate(rest);
  if (verb === "doc") return handleDoc(rest);
  if (verb === "red") return handleRed(rest);
  if (verb === "green") return handleGreen(rest);
  if (verb === "close") return handleClose(rest);
  if (verb === "status") return handleStatus(rest);
  if (verb === "search") return handleSearch(rest);
  if (verb === "validate") return handleValidate(rest);
  if (verb === "next-id") return handleNextId(rest);
  if (verb === "doctor") return handleVault(["doctor", ...rest]);
  if (verb === "sync") return handleSync(rest);
  if (verb === "session") return handleSession(rest);
  if (verb === "vault") return handleVault(rest);
  if (verb === "project") return handleProject(rest);
  if (verb === "handover") return handleCreate(["handover", ...rest]);
  console.error(`unknown verb: ${verb ?? ""}`.trim());
  console.error("verbs: create, doc, red, green, close, status, search, validate, next-id, doctor, sync, session, vault, project, handover");
  return { code: 1 };
}
