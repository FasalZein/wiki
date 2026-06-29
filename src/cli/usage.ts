/**
 * Single source of truth for the CLI's command surface (ADR-0023).
 *
 * Every verb and subverb declares a usage entry here. The same entries feed
 * both `--help` output (renderHelp) and the "valid options" lists printed by
 * "unknown X" errors, so the two can never disagree and the skill never has to
 * restate command syntax.
 */
export type UsageEntry = {
  summary: string;
  usage: string;
  flags?: Record<string, string>;
  example: string;
  subverbs?: Record<string, UsageEntry>;
};

export const USAGE_REGISTRY: Record<string, UsageEntry> = {
  create: {
    summary: "Create a new artifact of any kind configured in wiki.json.",
    usage: "wiki create <kind> [flags]",
    example: 'wiki create prd --project myproj --title "Short descriptive title"',
    subverbs: {
      prd: {
        summary: "Create a PRD.",
        usage: "wiki create prd --project <name> --title <title> [--body -]",
        flags: {
          "--project": "project name (required if the repo isn't linked)",
          "--title": "PRD title (required)",
          "--body": "authored body markdown ('-' reads stdin); H2 sections fill the template (## Problem Statement, ## Solution, ## User Stories, ## Implementation Decisions, ## Testing Decisions, ## Out of Scope, ## Further Notes)",
          "--supersedes": "id this PRD supersedes (marks the old one superseded)",
          "--related-to": "acknowledge a near-duplicate and link it instead of blocking",
          "--force-new": "bypass the advisory dedup gate",
        },
        example: 'cat prd-body.md | wiki create prd --project myproj --title "Short descriptive title" --body -',
      },
      slice: {
        summary: "Create a slice.",
        usage: "wiki create slice --project <name> --title <title> [--parent-prd <PRD-NNNN>] [--acceptance <c>]... [--body -]",
        flags: {
          "--project": "project name (required if the repo isn't linked)",
          "--title": "slice title (required)",
          "--parent-prd": "optional parent PRD id (recorded as a plain field; no existence check)",
          "--acceptance": "acceptance criterion (repeatable)",
          "--body": "authored body markdown ('-' reads stdin); only the ## What to build section — Todo/Evidence/Acceptance are rendered by the CLI",
          "--supersedes": "id this slice supersedes",
          "--related-to": "link a near-duplicate instead of blocking",
          "--force-new": "bypass the advisory dedup gate",
        },
        example: 'wiki create slice --project myproj --title "End-to-end behavior" --related-to PRD-0001 --acceptance "first criterion" --body -',
      },
      decision: {
        summary: "Create an ADR (architecture decision record).",
        usage: "wiki create decision --project <name> --title <t> --context <c> --decision <d> --consequences <q>",
        flags: {
          "--project": "project name (required if the repo isn't linked)",
          "--title": "decision title (required)",
          "--context": "what forces the decision (required)",
          "--decision": "the decision taken (required)",
          "--consequences": "resulting tradeoffs (required)",
          "--supersedes": "id this decision supersedes",
        },
        example: 'wiki create decision --project myproj --title "Use X" --context "..." --decision "..." --consequences "..."',
      },
      doc: {
        summary: "Create a knowledge doc in a bucket subfolder.",
        usage: "wiki create doc --project <name> --title <title> [--category <bucket>] [--body -]",
        flags: {
          "--project": "project name (required if the repo isn't linked)",
          "--title": "doc title (required)",
          "--category": "bucket subfolder (defaults to notes): architecture|research|runbooks|specs|notes|legacy",
          "--tags": "comma-separated tags",
          "--source-url": "source URL for research docs",
          "--body": "authored body markdown ('-' reads stdin); the ## Content section",
        },
        example: 'cat findings.md | wiki create doc --project myproj --title "How auth works" --category notes --body -',
      },
    },
  },
  doc: {
    summary: "Maintain existing docs in place (retitle / recategorize).",
    usage: "wiki doc <retitle|recategorize> <DOC-NNNN> --project <name> [--title <t>|--category <c>]",
    example: 'wiki doc recategorize DOC-0001 --project myproj --category architecture',
    subverbs: {
      retitle: {
        summary: "Rename a doc's title and re-slug its filename (stays in its category).",
        usage: "wiki doc retitle <DOC-NNNN> --project <name> --title <new title> [--json]",
        flags: { "--project": "project name (required)", "--title": "new title (required)", "--json": "emit {id,path} to stdout" },
        example: 'wiki doc retitle DOC-0001 --project myproj --title "Clearer title"',
      },
      recategorize: {
        summary: "Move a doc into another locked category subfolder.",
        usage: "wiki doc recategorize <DOC-NNNN> --project <name> --category <category> [--json]",
        flags: { "--project": "project name (required)", "--category": "architecture|research|runbooks|specs|notes|legacy", "--json": "emit {id,path} to stdout" },
        example: "wiki doc recategorize DOC-0001 --project myproj --category runbooks",
      },
    },
  },
  status: {
    summary: "Show a project's recent artifacts. Vault-wide (lists projects) with no --project.",
    usage: "wiki status [--project <name>]",
    flags: { "--project": "narrow to one project (optional)" },
    example: "wiki status --project myproj",
  },
  search: {
    summary: "Search artifacts by keyword. Vault-wide with no --project.",
    usage: "wiki search <query> [--project <name>] [--type <type>] [--recent] [--since <date>] [--include-research] [--explain] [--no-refresh] [--json]",
    flags: {
      "--project": "narrow to one project (optional; default: all projects)",
      "--type": "filter by artifact type",
      "--recent": "order by last-modified (newest first) instead of relevance; a temporal query (e.g. 'what changed recently') triggers this too",
      "--since": "only artifacts modified at/after this date (e.g. 2026-06-01); implies --recent ordering",
      "--include-research": "include research collection",
      "--explain": "include qmd's match explanation",
      "--no-refresh": "accepted for back-compat; search is read-only and never refreshes (no-op)",
      "--json": "emit a JSON array of {id,kind,title,path,score,snippet} hits ([] when empty)",
    },
    example: 'wiki search "rate limiting"',
  },
  validate: {
    summary: "Validate a single artifact file against its template schema and required body sections.",
    usage: "wiki validate <file> [--json]",
    flags: { "--json": "emit {ok,type,errors:[{field,reason,expected}]} to stdout" },
    example: "wiki validate projects/myproj/adrs/ADR-0001-foo.md",
  },
  "next-id": {
    summary: "Print the next available sequential id for an artifact type.",
    usage: "wiki next-id <prd|slice|decision|doc|handoff> --project <name>",
    flags: { "--project": "project name (required)" },
    example: "wiki next-id slice --project myproj",
  },
  set: {
    summary: "Set a field on an existing artifact (schema-validated). Type is inferred from the id. Bare set replaces; --add/--remove/--clear edit list/link_list fields additively.",
    usage: "wiki set <id> <field> <value...> | --add <v> | --remove <v> | --clear [--project <name>] [--json]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--add": "append a value to a list/link_list field without overwriting the rest (repeatable)",
      "--remove": "drop a value from a list/link_list field (repeatable)",
      "--clear": "empty a list/link_list field",
      "--json": "emit {id,field,value} to stdout; {error,...} to stderr on failure",
    },
    example: "wiki set SLICE-0032 blocked_by --add SLICE-0031",
  },
  block: {
    summary: "Set an artifact's blocked_by list; bare ids are auto-wrapped as [[..]] (no comma corruption).",
    usage: "wiki block <id> --on <id> [--on <id>...] [--project <name>] [--json]",
    flags: {
      "--on": "id this artifact is blocked by (repeatable)",
      "--project": "project name (required if the repo isn't linked)",
      "--json": "emit {id,blocked_by} to stdout; {error,...} to stderr on failure",
    },
    example: "wiki block SLICE-0032 --on SLICE-0030 --on SLICE-0031",
  },
  supersede: {
    summary: "Mark an existing artifact superseded by another (sets superseded_by, and status if the type has it).",
    usage: "wiki supersede <oldId> --by <newId> [--project <name>] [--json]",
    flags: {
      "--by": "id of the superseding artifact (required; must exist)",
      "--project": "project name (required if the repo isn't linked)",
      "--json": "emit {id,status,superseded_by} to stdout; {error,...} to stderr on failure",
    },
    example: "wiki supersede SLICE-0016 --by SLICE-0032",
  },
  path: {
    summary: "Print the absolute file path for an artifact id (resolve-by-id without globbing).",
    usage: "wiki path <id> [--project <name>] [--json]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--json": "emit {id,path} to stdout",
    },
    example: "wiki path SLICE-0032",
  },
  links: {
    summary: "Show an artifact's outbound links and inbound backlinks (pure vault read, no qmd).",
    usage: "wiki links <id> [--project <name>] [--json]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--json": "emit {id,outbound,inbound} to stdout",
    },
    example: "wiki links SLICE-0032",
  },
  retitle: {
    summary: "Change an artifact's title and re-slug its filename for any kind; the id (and [[id]] links) survive.",
    usage: "wiki retitle <id> --title <title> [--project <name>] [--json]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--title": "new title (required)",
      "--json": "emit {id,title,path} to stdout",
    },
    example: 'wiki retitle SLICE-0032 --title "A clearer title"',
  },
  delete: {
    summary: "Remove an artifact file; refuses if other artifacts link to it unless --force. Run wiki sync to drop it from search.",
    usage: "wiki delete <id> [--force] [--project <name>] [--json]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--force": "delete even when inbound references exist",
      "--json": "emit {id,deleted,inbound} to stdout",
    },
    example: "wiki delete SLICE-0032",
  },
  schema: {
    summary: "List an artifact type's fields, types, required flags, and enum values. A bucket name also prints its criteria.",
    usage: "wiki schema <kind|bucket> [--json]",
    flags: { "--json": "emit the schema object to stdout (a bucket adds its criteria)" },
    example: "wiki schema slice",
  },
  doctor: {
    summary: "Check vault health (docs-structure and repo-binding drift). --setup checks distribution health (binary freshness, skill-bundle presence, hook install state).",
    usage: "wiki doctor [--setup]",
    flags: { "--setup": "check distribution health instead of vault drift (binary freshness, skill bundle, hook wiring)" },
    example: "wiki doctor --setup",
  },
  fmt: {
    summary: "Format vault artifacts. Default mode is check: report format drift and exit 1 if any; --write applies the mechanical fixes idempotently (dates, frontmatter order, legacy-id renumber, and renaming files to <ID>-<slug>.md when id/slug drift from the filename — id preserved so links survive).",
    usage: "wiki fmt [--project <name>] [--write]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--write": "apply fixes (without it, check mode only reports)",
    },
    example: "wiki fmt --project myproj --write",
  },
  sync: {
    summary: "Re-index a project into the QMD search collections.",
    usage: "wiki sync [--project <name>] [--include-research] [--pull] [--force-embed]",
    flags: {
      "--project": "project name (required if the repo isn't linked)",
      "--include-research": "also sync the research collection",
      "--pull": "pull remote changes before indexing",
      "--force-embed": "re-embed all documents",
    },
    example: "wiki sync --project myproj",
  },
  vault: {
    summary: "Vault administration (init, doctor).",
    usage: "wiki vault <init|doctor> [args]",
    example: "wiki vault doctor",
    subverbs: {
      init: {
        summary: "Initialize a new vault at a path (creates projects/, .wiki/, git).",
        usage: "wiki vault init <path>",
        example: "wiki vault init ~/Knowledge",
      },
      doctor: {
        summary: "Report docs-structure and repo-binding drift. --setup reports distribution health (binary freshness, skill-bundle presence, hook install state).",
        usage: "wiki vault doctor [--setup]",
        flags: { "--setup": "check distribution health instead of vault drift" },
        example: "wiki vault doctor --setup",
      },
    },
  },
  project: {
    summary: "Manage projects (create, list, link).",
    usage: "wiki project <create|list|link> [name]",
    example: "wiki project create myproj",
    subverbs: {
      create: {
        summary: "Create a new project directory structure under projects/.",
        usage: "wiki project create <name> [--repo <path>]",
        flags: {
          "--repo": "path to the code repo this project tracks (default: current directory)",
        },
        example: "wiki project create myproj --repo ~/code/myproj",
      },
      list: {
        summary: "List existing projects.",
        usage: "wiki project list",
        example: "wiki project list",
      },
      link: {
        summary: "Bind a code repo to a project: stamp the wiki pointer block into its AGENTS.md/CLAUDE.md. This is the single repo→project binding the CLI resolves --project from.",
        usage: "wiki project link --project <name> [--repo <path>]",
        flags: {
          "--project": "project name (required)",
          "--repo": "path to the code repo to bind (default: current directory)",
        },
        example: "wiki project link --project myproj",
      },
    },
  },
  hooks: {
    summary: "Install per-runtime hooks that remind the agent to persist a skill's output to the vault.",
    usage: "wiki hooks <install|uninstall|list|status|run>",
    example: "wiki hooks install --runtime claude-code --global",
    subverbs: {
      install: {
        summary: "Write the skill→artifact hook plus a session-end persist reminder into a runtime's native config (merges, never clobbers).",
        usage: "wiki hooks install --runtime <claude-code|codex|pi> [--global]",
        flags: {
          "--runtime": "claude-code, codex, or pi",
          "--global": "write to the user-level config (~/...) instead of the current repo",
        },
        example: "wiki hooks install --runtime claude-code --global",
      },
      uninstall: {
        summary: "Splice out only the wiki hook entries (command === 'wiki hooks run'), leaving unrelated hooks/keys intact.",
        usage: "wiki hooks uninstall --runtime <claude-code|codex|pi> [--global]",
        flags: {
          "--runtime": "claude-code, codex, or pi",
          "--global": "target the user-level config (~/...) instead of the current repo",
        },
        example: "wiki hooks uninstall --runtime claude-code --global",
      },
      list: {
        summary: "List each runtime/scope and whether the wiki hook is wired.",
        usage: "wiki hooks list",
        example: "wiki hooks list",
      },
      status: {
        summary: "Report which runtimes/scopes have the wiki hook wired.",
        usage: "wiki hooks status",
        example: "wiki hooks status",
      },
      run: {
        summary: "Hook callback: reads a runtime's hook payload on stdin, emits guidance on stdout. Invoked by the installed config, not by hand.",
        usage: "wiki hooks run",
        example: "echo '{\"tool_input\":{\"skill_name\":\"to-slices\"}}' | wiki hooks run",
      },
    },
  },
};

export const VERB_NAMES: string[] = Object.keys(USAGE_REGISTRY);

/** True when the args request help (--help or -h anywhere). */
export function wantsHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** Render a single usage entry into help text. */
export function renderHelp(name: string, entry: UsageEntry): string {
  const lines: string[] = [];
  lines.push(entry.summary);
  lines.push("");
  lines.push(`usage: ${entry.usage}`);
  if (entry.flags && Object.keys(entry.flags).length > 0) {
    lines.push("");
    lines.push("Flags:");
    const width = Math.max(...Object.keys(entry.flags).map((f) => f.length));
    for (const [flag, desc] of Object.entries(entry.flags)) {
      lines.push(`  ${flag.padEnd(width)}  ${desc}`);
    }
  }
  if (entry.subverbs && Object.keys(entry.subverbs).length > 0) {
    lines.push("");
    lines.push("Subcommands:");
    const width = Math.max(...Object.keys(entry.subverbs).map((s) => s.length));
    for (const [sub, subEntry] of Object.entries(entry.subverbs)) {
      lines.push(`  ${sub.padEnd(width)}  ${subEntry.summary}`);
    }
    lines.push("");
    lines.push(`Run 'wiki ${name} <subcommand> --help' for details.`);
  }
  lines.push("");
  lines.push(`Example: ${entry.example}`);
  return lines.join("\n");
}

/** Render the top-level verb list. */
export function renderVerbList(): string {
  const lines: string[] = [];
  lines.push("wiki — vault delivery workflow CLI");
  lines.push("");
  lines.push("usage: wiki <verb> [args]   (run 'wiki <verb> --help' for details)");
  lines.push("");
  lines.push("Verbs:");
  const width = Math.max(...VERB_NAMES.map((v) => v.length));
  for (const verb of VERB_NAMES) {
    lines.push(`  ${verb.padEnd(width)}  ${USAGE_REGISTRY[verb]?.summary ?? ""}`);
  }
  lines.push("");
  lines.push("A value that starts with '-' (e.g. a title) is read as a flag. Pass it as");
  lines.push("--flag=value (e.g. --title=-foo) or after a '--' escape so it parses as a value.");
  return lines.join("\n");
}

/**
 * Format an "unknown X" error: the bad token plus the valid set, drawn from the
 * same registry that powers --help (ADR-0023). `valid` lets callers pass a
 * subverb set; defaults to the top-level verbs.
 */
export function unknownMessage(kind: string, got: string, valid: string[] = VERB_NAMES): string {
  const head = `unknown ${kind}: ${got}`.trim();
  return `${head}\nvalid ${kind}s: ${valid.join(", ")}`;
}
