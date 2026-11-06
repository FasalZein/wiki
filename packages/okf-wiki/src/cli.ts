import { parseArgs } from "node:util";
import * as path from "node:path";
import { initVault, WikiError, type ErrorCode } from "./vault.ts";

const EXIT: Record<ErrorCode, number> = { usage: 2, conflict: 3, not_found: 4, unsupported: 5, damaged: 6 };
const USAGE = "okf-wiki (Node source CLI)\nUsage: okf-wiki init <dir> [--json]\n       okf-wiki --vault <dir> init [--json]\nVault: explicit directory, --vault, or WIKI_VAULT. No default vault.\n";
let json = process.argv.slice(2).includes("--json");
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { vault: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  json = values.json ?? false;
  if (values.help) {
    process.stdout.write(json ? JSON.stringify({ ok: true, help: USAGE }) + "\n" : USAGE);
  } else {
    const [command, dir, ...extra] = positionals;
    if (command !== "init" || extra.length) throw new WikiError("usage", USAGE);
    if (values.vault !== undefined && dir !== undefined && path.resolve(values.vault) !== path.resolve(dir)) {
      throw new WikiError("usage", "Conflicting vault selections: --vault and init <dir> name different directories");
    }
    const selected = values.vault ?? dir ?? process.env.WIKI_VAULT;
    if (!selected || selected.trim() === "" || selected.includes("\0")) throw new WikiError("usage", "Select a vault with init <dir>, --vault <dir>, or WIKI_VAULT; no default vault exists");
    const vault = initVault(selected);
    process.stdout.write(json ? JSON.stringify({ ok: true, vault }) + "\n" : "Initialized profile vault: " + vault.root + "\n");
  }
} catch (error) {
  const known = error instanceof WikiError;
  const argumentError = error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_");
  const code = known ? error.code : argumentError ? "usage" : "internal";
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = known ? EXIT[error.code] : argumentError ? 2 : 1;
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  else process.stderr.write(code + ": " + message + "\n");
}
