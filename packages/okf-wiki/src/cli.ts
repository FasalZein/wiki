import * as fs from "node:fs";
import { parseArgs } from "node:util";
import * as path from "node:path";
import { initVault, WikiError, type ErrorCode } from "./vault.ts";
import { addType, listTypes, loadRegistry, openVault, RegistryWriteError, sortDiagnostics } from "./registry.ts";
import { readNote } from "./read.ts";
import { inspectVault, lintVault } from "./lint.ts";
import { indexDestinationDiagnostics, indexFreshnessDiagnostics } from "./navigation.ts";

const EXIT: Record<ErrorCode, number> = { usage: 2, conflict: 3, not_found: 4, unsupported: 5, damaged: 6 };
const USAGE = "okf-wiki (Node source CLI)\nUsage: okf-wiki init <dir> [--json]\n       okf-wiki --vault <dir> init [--json]\n       okf-wiki --vault <dir> type list [--json]\n       okf-wiki --vault <dir> type add <name> --folder <folder> [--json]\n       okf-wiki --vault <dir> lint [path] [--json]\n       okf-wiki --vault <dir> index [--check] [--json]\n       okf-wiki --vault <dir> show <path> [--section <heading>] [--json]\nWhole-vault lint checks registry, frontmatter, layout, body, lifecycle, scoped titles, links, and generated-index freshness. Selected-path lint does not check generated-index freshness.\nVault: explicit directory, --vault, or WIKI_VAULT. No default vault.\n";
let json = process.argv.slice(2).includes("--json");
function output(value: object, human: string) { process.stdout.write(json ? JSON.stringify(value) + "\n" : human); }
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { vault: { type: "string" }, folder: { type: "string" }, section: { type: "string" }, json: { type: "boolean" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  json = values.json ?? false;
  if (values.help) {
    output({ ok: true, help: USAGE }, USAGE);
  } else {
    const [command, arg, ...extra] = positionals;
    const init = command === "init";
    const list = command === "type" && arg === "list" && extra.length === 0;
    const add = command === "type" && arg === "add" && extra.length === 1 && values.folder !== undefined;
    const index = command === "index" && arg === undefined && extra.length === 0;
    if (values.check !== undefined && !index) throw new WikiError("usage", "--check is only valid with index");
    const show = command === "show" && arg !== undefined && extra.length === 0;
    if (values.section !== undefined && !show) throw new WikiError("usage", "--section is only valid with show <path>");
    if (!(show || index || init && extra.length === 0 || list || add || command === "lint" && extra.length === 0) || values.folder !== undefined && !add) throw new WikiError("usage", USAGE);
    if (init && values.vault !== undefined && arg !== undefined && path.resolve(values.vault) !== path.resolve(arg)) {
      throw new WikiError("usage", "Conflicting vault selections: --vault and init <dir> name different directories");
    }
    const selected = values.vault ?? (init ? arg : undefined) ?? process.env.WIKI_VAULT;
    if (!selected || selected.trim() === "" || selected.includes("\0")) throw new WikiError("usage", "Select a vault with init <dir>, --vault <dir>, or WIKI_VAULT; no default vault exists");
    if (init) {
      const vault = initVault(selected);
      output({ ok: true, vault }, "Initialized profile vault: " + vault.root + "\n");
    } else {
      const root = openVault(selected);
      if (show && arg !== undefined) {
        const note = readNote(root, arg, values.section);
        output({ ok: true, ...note }, note.markdown);
      } else if (add && extra[0] !== undefined && values.folder !== undefined) {
        const added = addType(root, extra[0], values.folder);
        output({ ok: true, path: added }, "Created registry scaffold: " + added + "; review and run whole-vault lint before commit\n");
      } else {
        const registry = list ? loadRegistry(root) : undefined;
        const inventory = index ? inspectVault(root) : undefined;
        const diagnostics = registry ? registry.diagnostics : inventory ? inventory.diagnostics : lintVault(root, arg);
        if (inventory && !diagnostics.length) {
          diagnostics.push(...(values.check ? indexFreshnessDiagnostics(root, inventory.indexes) : indexDestinationDiagnostics(root, inventory.indexes.keys())));
          sortDiagnostics(diagnostics);
        }
        if (diagnostics.length) {
          process.exitCode = 1;
          const error = { code: "lint", message: "Wiki validation failed" };
          if (json) output({ ok: false, error, diagnostics }, "");
          else process.stderr.write(diagnostics.map(d => d.path + ": " + d.rule + ": " + d.message + "; fix: " + d.fix).join("\n") + "\n");
        } else if (inventory) {
          if (!values.check) for (const [relative, bytes] of inventory.indexes) fs.writeFileSync(path.join(root, relative), bytes);
          const paths = [...inventory.indexes.keys()].sort();
          output({ ok: true, paths, checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", "generated-index"] }, values.check ? "Generated indexes are current\n" : "Generated navigation: " + paths.join(", ") + "\n");
        } else if (registry) {
          const types = listTypes(registry.types);
          output({ ok: true, types }, types.map(t => t.name + " folder=" + t.folder + " required=" + t.requiredFields.join(",") + " headings=" + t.requiredHeadings.map(h => h.level + ":" + h.text).join(",") + " scopes=" + (t.scopes?.join(",") ?? "all")).join("\n") + "\n");
        } else output({ ok: true, diagnostics: [], checks: ["registry", "frontmatter", "layout", "body", "lifecycle", "scoped-titles", "links", ...(arg === undefined ? ["generated-index"] : [])] }, "Wiki lint passed (registry, frontmatter, layout, body, lifecycle, scoped titles, links; generated-index freshness " + (arg === undefined ? "checked" : "not checked for selected paths") + ")\n");
      }
    }
  }
} catch (error) {
  const known = error instanceof WikiError;
  const argumentError = error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_");
  const code = known ? error.code : argumentError ? "usage" : "internal";
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = known ? EXIT[error.code] : argumentError ? 2 : 1;
  const partial = error instanceof RegistryWriteError ? { written: error.written, paths: error.paths, digest: error.digest } : {};
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: { code, message }, ...partial }) + "\n");
  else process.stderr.write(code + ": " + message + "\n");
}
