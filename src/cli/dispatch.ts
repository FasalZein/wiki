import { handleCreate } from "./verbs/create";
import { handleDoc } from "./verbs/doc";
import { handleFmt } from "./verbs/fmt";
import { handleHooks } from "./verbs/hooks";
import { handleLinks } from "./verbs/links";
import { handleBlock, handleDelete, handlePath, handleRetitle, handleSet, handleSupersede } from "./verbs/mutate";
import { handleNextId } from "./verbs/next-id";
import { handleProject } from "./verbs/project";
import { handleSchema } from "./verbs/schema";
import { handleSearch } from "./verbs/search";
import { handleStatus } from "./verbs/status";
import { handleSync } from "./verbs/sync";
import { handleValidate } from "./verbs/validate";
import { handleVault } from "./verbs/vault";
import { USAGE_REGISTRY, renderHelp, renderVerbList, unknownMessage, wantsHelp } from "./usage";
import { setJsonMode } from "./output";
import { resolveVaultRootForDisplay } from "../config/vault";
import { readLinkedProject } from "./repo-link";

export type CliResult = {
  code: number;
};

/**
 * Print a deterministic one-line context banner to stderr before any command runs:
 * where the vault is (so artifacts are never written into the project's own folder)
 * and, when this repo is linked, which project it points at (so an agent knows
 * the repo is already on the wiki without running discovery tools). stderr
 * keeps the scriptable stdout (ids, log paths, search hits) clean.
 */
async function printContextBanner(): Promise<void> {
  const vault = await resolveVaultRootForDisplay();
  if (vault === null) {
    console.error("wiki vault: (unconfigured — set KNOWLEDGE_VAULT_ROOT or ~/.config/wiki/config.toml vault.root)");
    return;
  }
  const project = await readLinkedProject(process.cwd()).catch(() => null);
  const linked = project === null ? "this repo isn't linked — run wiki project link --project <name>" : `project ${project}`;
  console.error(`wiki vault: ${vault}  |  ${linked}`);
}

export async function dispatch(args: string[]): Promise<CliResult> {
  // Strip the global --json flag centrally (P1.1): the per-verb parsers are
  // strict and would reject an unknown flag, so it must never reach them.
  const jsonFlag = args.includes("--json");
  setJsonMode(jsonFlag);
  const [verb, ...rest] = args.filter((arg) => arg !== "--json");

  // Top-level help: bare `wiki` or `wiki --help` lists all verbs.
  if (verb === undefined || verb === "--help" || verb === "-h") {
    console.log(renderVerbList());
    return { code: 0 };
  }

  // Per-verb / per-subverb help, intercepted before argument validation so
  // `wiki status --help` never reaches the positional parser (ADR-0023).
  if (wantsHelp(rest)) {
    const entry = USAGE_REGISTRY[verb];
    if (entry === undefined) {
      console.error(unknownMessage("verb", verb));
      return { code: 1 };
    }
    const subverb = rest[0];
    if (entry.subverbs !== undefined && subverb !== undefined && subverb !== "--help" && subverb !== "-h") {
      const subEntry = entry.subverbs[subverb];
      if (subEntry !== undefined) {
        console.log(renderHelp(`${verb} ${subverb}`, subEntry));
        return { code: 0 };
      }
    }
    console.log(renderHelp(verb, entry));
    return { code: 0 };
  }

  // Deterministic context banner (vault + linked project) for every real command.
  // Suppressed under --json so stderr carries only structured diagnostics.
  if (!jsonFlag) await printContextBanner();

  if (verb === "create") return handleCreate(rest);
  if (verb === "set") return handleSet(rest);
  if (verb === "block") return handleBlock(rest);
  if (verb === "supersede") return handleSupersede(rest);
  if (verb === "path") return handlePath(rest);
  if (verb === "links") return handleLinks(rest);
  if (verb === "retitle") return handleRetitle(rest);
  if (verb === "delete") return handleDelete(rest);
  if (verb === "schema") return handleSchema(rest);
  if (verb === "doc") return handleDoc(rest);
  if (verb === "status") return handleStatus(rest);
  if (verb === "search") return handleSearch(rest);
  if (verb === "validate") return handleValidate(rest);
  if (verb === "next-id") return handleNextId(rest);
  if (verb === "doctor") return handleVault(["doctor", ...rest]);
  if (verb === "fmt") return handleFmt(rest);
  if (verb === "sync") return handleSync(rest);
  if (verb === "vault") return handleVault(rest);
  if (verb === "project") return handleProject(rest);
  if (verb === "hooks") return handleHooks(rest);
  console.error(unknownMessage("verb", verb ?? ""));
  return { code: 1 };
}
