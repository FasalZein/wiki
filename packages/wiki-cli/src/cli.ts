import * as fs from "node:fs";
import { parseArgs } from "node:util";
import {
  AUTHORITIES,
  type Authority,
  CHECK_METHODS,
  CHECK_OUTCOMES,
  type CheckMethod,
  type CheckOutcome,
  captureCode,
  captureWeb,
  createNote,
  importDocumentFile,
  importPdfFile,
  importTextFile,
  initVault,
  loadObservation,
  observationText,
  openVault,
  type ReadResult,
  readNote,
  recordCheck,
  setRepo,
  type Vault,
  WikiError,
} from "../../wiki-core/src/index.ts";

const USAGE = `wiki-cli: standalone knowledge CLI (Node, no Pi, no background service)

Usage: wiki-cli <command> [options]   (global: --vault <dir> or WIKI_VAULT, --json)

  init <dir>                                     create a new disposable vault
  repo add <name> --path <abs-dir> [--ref main]  bind a local Git repository
  note create --id <id> --authority <a> --title <t> (--body <text> | --body-file <file>)
                                                 authority: ${AUTHORITIES.join(" | ")}
  capture text <file> [--request-id <id>]        import UTF-8 .txt/.md with original bytes
  capture pdf <file> [--request-id <id>]         import a PDF with pdftotext (external program)
  capture file <file> [--request-id <id>]        import text or PDF by extension; other types are refused
  capture web <url> [--request-id <id>] [--observed-at <iso>]
                                                 fetch one http(s) URL with pandoc (external program)
  capture code --repo <name> --path <p>... [--request-id <id>]
                                                 snapshot committed files at the configured local ref
  source show <observation-id> [--text]          show a retained source observation
  read <note-id>                                 note body, content digest, and trust status
  check <note-id> --note-digest <sha256:..> --source <observation-id>...
        --outcome ${CHECK_OUTCOMES.join("|")} --checker <name> --method ${CHECK_METHODS.join("|")} --request-id <id>
                                                 record a check of a reviewed note revision

Exit codes: 0 ok, 1 error, 2 usage, 3 conflict, 4 not found, 5 unsupported, 6 damaged evidence, 7 unavailable.
`;

const EXIT: Record<WikiError["code"], number> = {
  usage: 2,
  invalid_input: 2,
  conflict: 3,
  exists: 3,
  not_found: 4,
  unsupported: 5,
  damaged: 6,
  unavailable: 7,
};

const { values: opts, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        vault: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        path: { type: "string", multiple: true },
        ref: { type: "string" },
        id: { type: "string" },
        authority: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        "body-file": { type: "string" },
        "request-id": { type: "string" },
        "observed-at": { type: "string" },
        repo: { type: "string" },
        text: { type: "boolean", default: false },
        "note-digest": { type: "string" },
        source: { type: "string", multiple: true },
        outcome: { type: "string" },
        checker: { type: "string" },
        method: { type: "string" },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
})();

function need(name: string, value: string | undefined): string {
  if (value === undefined || value === "") throw new WikiError("usage", `missing ${name}`);
  return value;
}

function vault(): Vault {
  const dir = opts.vault ?? process.env.WIKI_VAULT;
  if (!dir) throw new WikiError("usage", "no vault: pass --vault <dir> or set WIKI_VAULT");
  return openVault(dir);
}

function requestId(): { requestId?: string } {
  return opts["request-id"] === undefined ? {} : { requestId: opts["request-id"] };
}

function observedAt(): { observedAt?: string } {
  return opts["observed-at"] === undefined ? {} : { observedAt: opts["observed-at"] };
}

function emit(data: Record<string, unknown>, text: string): void {
  process.stdout.write(opts.json ? `${JSON.stringify({ ok: true, ...data }, null, 2)}\n` : `${text}\n`);
}

function renderRead(r: ReadResult): string {
  const lines = [
    `# ${r.title ?? r.id}`,
    `id: ${r.id}  authority: ${r.authority}  path: ${r.path}`,
    `status: ${r.status}`,
    `content: ${r.digest}`,
    ...r.reasons.map((x) => `  - ${x}`),
  ];
  for (const repo of r.repos) {
    lines.push(repo.ok ? `repo ${repo.repo}: ${repo.ref} -> ${repo.commit} (local commit only; no fetch, no uncommitted changes)` : `repo ${repo.repo}: unavailable (${repo.reason})`);
  }
  for (const s of r.sources) lines.push(`source ${s.observationId} [${s.state}]: ${s.reason}`);
  lines.push("", r.body);
  return lines.join("\n");
}

async function run(signal: AbortSignal): Promise<void> {
  const [command, sub, arg] = positionals;
  if (opts.help || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  switch (command) {
    case "init": {
      const v = initVault(need("<dir>", sub ?? opts.vault));
      emit({ vault: v.root }, `vault ready: ${v.root}`);
      return;
    }
    case "repo": {
      if (sub !== "add") throw new WikiError("usage", "expected: repo add <name> --path <dir> [--ref <ref>]");
      const repoPath = need("--path", opts.path?.[0]);
      const v = setRepo(vault(), need("<name>", arg), repoPath, opts.ref ?? "main");
      const name = arg as string;
      emit({ repo: name, ...v.config.repos[name] }, `repo ${name}: ${repoPath} @ ${opts.ref ?? "main"}`);
      return;
    }
    case "note": {
      if (sub !== "create") throw new WikiError("usage", "expected: note create ...");
      const authority = need("--authority", opts.authority);
      if (!AUTHORITIES.includes(authority as Authority)) throw new WikiError("usage", `--authority must be one of ${AUTHORITIES.join(", ")}`);
      if ((opts.body === undefined) === (opts["body-file"] === undefined)) throw new WikiError("usage", "pass exactly one of --body or --body-file");
      const body = opts.body ?? fs.readFileSync(opts["body-file"] as string, "utf8");
      const note = createNote(vault(), { id: need("--id", opts.id), authority: authority as Authority, title: need("--title", opts.title), body });
      emit({ id: note.id, path: note.path, digest: note.digest, authority: note.authority }, `created ${note.path} (${note.digest})`);
      return;
    }
    case "capture": {
      if (sub === "text") {
        const r = importTextFile(vault(), need("<file>", arg), requestId().requestId);
        emit({ replayed: r.replayed, observation: r.observation }, `${r.replayed ? "replayed" : "captured"} ${r.observation.id} ${r.observation.original.digest}`);
        return;
      }
      if (sub === "pdf") {
        const r = await importPdfFile(vault(), need("<file>", arg), { ...requestId(), ...observedAt(), signal });
        emit({ replayed: r.replayed, observation: r.observation }, `${r.replayed ? "replayed" : "captured"} ${r.observation.id} ${r.observation.original.digest}`);
        return;
      }
      if (sub === "file") {
        const r = await importDocumentFile(vault(), need("<file>", arg), { ...requestId(), ...observedAt(), signal });
        emit({ replayed: r.replayed, observation: r.observation }, `${r.replayed ? "replayed" : "captured"} ${r.observation.id} ${r.observation.original.digest}`);
        return;
      }
      if (sub === "web") {
        const r = await captureWeb(vault(), need("<url>", arg), { ...requestId(), ...observedAt(), signal });
        emit({ replayed: r.replayed, observation: r.observation }, `${r.replayed ? "replayed" : "captured"} ${r.observation.id} ${r.observation.original.digest}`);
        return;
      }
      if (sub === "code") {
        const results = captureCode(vault(), need("--repo", opts.repo), opts.path ?? [], requestId().requestId);
        emit(
          { observations: results.map((r) => ({ replayed: r.replayed, ...r.observation })) },
          results
            .map((r) => {
              const loc = r.observation.locator;
              return `${r.replayed ? "replayed" : "captured"} ${r.observation.id} ${loc.kind === "code" ? `${loc.repo}:${loc.path} @ ${loc.ref} ${loc.commit} (local commit only)` : ""} ${r.observation.original.digest}`;
            })
            .join("\n"),
        );
        return;
      }
      throw new WikiError("usage", `capture supports: text, pdf, file, web, code (got ${sub ?? "nothing"})`);
    }
    case "source": {
      if (sub !== "show") throw new WikiError("usage", "expected: source show <observation-id>");
      const v = vault();
      const o = loadObservation(v, need("<observation-id>", arg));
      const text = opts.text ? observationText(v, o) : undefined;
      emit({ observation: o, ...(text === undefined ? {} : { text }) }, `${JSON.stringify(o, null, 2)}${text === undefined ? "" : `\n\n${text}`}`);
      return;
    }
    case "read": {
      const r = readNote(vault(), need("<note-id>", sub));
      emit({ ...r }, renderRead(r));
      return;
    }
    case "check": {
      const outcome = need("--outcome", opts.outcome);
      const method = need("--method", opts.method);
      if (!CHECK_OUTCOMES.includes(outcome as CheckOutcome)) throw new WikiError("usage", `--outcome must be ${CHECK_OUTCOMES.join(" or ")}`);
      if (!CHECK_METHODS.includes(method as CheckMethod)) throw new WikiError("usage", `--method must be ${CHECK_METHODS.join(" or ")}`);
      const { check, replayed } = recordCheck(vault(), {
        requestId: need("--request-id", opts["request-id"]),
        noteId: need("<note-id>", sub),
        noteDigest: need("--note-digest", opts["note-digest"]),
        sourceIds: opts.source ?? [],
        outcome: outcome as CheckOutcome,
        checker: need("--checker", opts.checker),
        method: method as CheckMethod,
      });
      emit({ replayed, check }, `${replayed ? "replayed (no change)" : "recorded"} check ${check.id} of ${check.noteId} at ${check.noteDigest}`);
      return;
    }
    default:
      throw new WikiError("usage", `unknown command ${command}`);
  }
}

const abort = new AbortController();
const stop = (): void => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

run(abort.signal)
  .catch((error: unknown) => {
    const known = error instanceof WikiError;
    const code = known ? error.code : "error";
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
    process.stderr.write(`wiki-cli: ${code}: ${message}\n`);
    process.exitCode = known ? EXIT[error.code] : 1;
  })
  .finally(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
