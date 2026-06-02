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
    summary: "Create a new artifact (prd, slice, decision, doc, handover).",
    usage: "wiki create <prd|slice|decision|doc|handover> [flags]",
    example: 'wiki create prd --project myproj --title "Short descriptive title"',
    subverbs: {
      prd: {
        summary: "Create a PRD.",
        usage: "wiki create prd --project <name> --title <title>",
        flags: {
          "--project": "project name (required if no active session)",
          "--title": "PRD title (required)",
          "--supersedes": "id this PRD supersedes (marks the old one superseded)",
          "--related-to": "acknowledge a near-duplicate and link it instead of blocking",
          "--force-new": "bypass the advisory dedup gate",
        },
        example: 'wiki create prd --project myproj --title "Short descriptive title"',
      },
      slice: {
        summary: "Create a slice under a parent PRD.",
        usage: "wiki create slice --project <name> --title <title> --parent-prd <PRD-NNNN>",
        flags: {
          "--project": "project name (required if no active session)",
          "--title": "slice title (required)",
          "--parent-prd": "parent PRD id (required; must exist)",
          "--supersedes": "id this slice supersedes",
          "--related-to": "link a near-duplicate instead of blocking",
          "--force-new": "bypass the advisory dedup gate",
        },
        example: 'wiki create slice --project myproj --title "End-to-end behavior" --parent-prd PRD-0001',
      },
      decision: {
        summary: "Create an ADR (architecture decision record).",
        usage: "wiki create decision --project <name> --title <t> --context <c> --decision <d> --consequences <q>",
        flags: {
          "--project": "project name (required if no active session)",
          "--title": "decision title (required)",
          "--context": "what forces the decision (required)",
          "--decision": "the decision taken (required)",
          "--consequences": "resulting tradeoffs (required)",
          "--supersedes": "id this decision supersedes",
        },
        example: 'wiki create decision --project myproj --title "Use X" --context "..." --decision "..." --consequences "..."',
      },
      doc: {
        summary: "Create a knowledge doc in a locked category subfolder.",
        usage: "wiki create doc --project <name> --title <title> --type <type> [--category <cat>]",
        flags: {
          "--project": "project name (required if no active session)",
          "--title": "doc title (required)",
          "--type": "doc type (required): runbook|research|guide|learning|reference",
          "--category": "locked category (defaults from --type): architecture|research|runbooks|specs|notes|legacy",
          "--tags": "comma-separated tags",
          "--source-url": "source URL for research docs",
        },
        example: 'wiki create doc --project myproj --title "How auth works" --type reference',
      },
      handover: {
        summary: "Create a handover artifact capturing session state and next-phase routing.",
        usage: "wiki create handover [--project <name>] [--phase <phase>] [--next-phase <phase>] [flags]",
        flags: {
          "--project": "project name (required if no active session)",
          "--phase": "current phase (required if no active session)",
          "--next-phase": "phase the next agent should resume in",
          "--active-prd": "PRD this session operated on",
          "--active-slice": "slice in progress (repeatable)",
          "--decision": "decision made this session (repeatable)",
          "--suggested-skill": "skill the next agent should load (repeatable)",
          "--produced": "what this session produced ('-' reads stdin)",
          "--open": "open threads / next steps ('-' reads stdin)",
          "--no-doc": "suppress the auto-printed next-phase guidance",
        },
        example: 'wiki create handover --project myproj --next-phase slice --produced "PRD-0006 published"',
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
        usage: "wiki doc retitle <DOC-NNNN> --project <name> --title <new title>",
        flags: { "--project": "project name (required)", "--title": "new title (required)" },
        example: 'wiki doc retitle DOC-0001 --project myproj --title "Clearer title"',
      },
      recategorize: {
        summary: "Move a doc into another locked category subfolder.",
        usage: "wiki doc recategorize <DOC-NNNN> --project <name> --category <category>",
        flags: { "--project": "project name (required)", "--category": "architecture|research|runbooks|specs|notes|legacy" },
        example: "wiki doc recategorize DOC-0001 --project myproj --category runbooks",
      },
    },
  },
  red: {
    summary: "TDD red gate: run tests, require at least one failure, record the log.",
    usage: "wiki red <SLICE-NNNN> --project <name>",
    flags: { "--project": "project name (required)" },
    example: "wiki red SLICE-0001 --project myproj",
  },
  green: {
    summary: "TDD green gate: run tests, require all prior red failures now pass.",
    usage: "wiki green <SLICE-NNNN> --project <name>",
    flags: { "--project": "project name (required)" },
    example: "wiki green SLICE-0001 --project myproj",
  },
  close: {
    summary: "Close a slice after todos, evidence, and review verdict are satisfied.",
    usage: "wiki close <SLICE-NNNN> --project <name> --review-verdict <pass|pass-with-notes|reject>",
    flags: { "--project": "project name (required)", "--review-verdict": "pass|pass-with-notes|reject" },
    example: "wiki close SLICE-0001 --project myproj --review-verdict pass",
  },
  status: {
    summary: "Show phase, active artifacts, and next step. Vault-wide with no --project.",
    usage: "wiki status [--project <name>] [--with-doc]",
    flags: { "--project": "narrow to one project (optional)", "--with-doc": "include inline phase guidance" },
    example: "wiki status --project myproj --with-doc",
  },
  search: {
    summary: "Search artifacts by keyword. Vault-wide with no --project.",
    usage: "wiki search <query> [--project <name>] [--type <type>] [--include-research]",
    flags: { "--project": "narrow to one project (optional; default: all projects)", "--type": "filter by artifact type", "--include-research": "include research collection" },
    example: 'wiki search "rate limiting"',
  },
  validate: {
    summary: "Validate a single artifact file against its template schema.",
    usage: "wiki validate <file>",
    example: "wiki validate projects/myproj/adrs/ADR-0001-foo.md",
  },
  "next-id": {
    summary: "Print the next available sequential id for an artifact type.",
    usage: "wiki next-id <prd|slice|decision|doc|handover> --project <name>",
    flags: { "--project": "project name (required)" },
    example: "wiki next-id slice --project myproj",
  },
  doctor: {
    summary: "Check vault health (Obsidian plugins, templates, config drift).",
    usage: "wiki doctor",
    example: "wiki doctor",
  },
  sync: {
    summary: "Re-index a project into the QMD search collections.",
    usage: "wiki sync --project <name> [--include-research] [--pull] [--force-embed]",
    flags: {
      "--project": "project name (required)",
      "--include-research": "also sync the research collection",
      "--pull": "pull remote changes before indexing",
      "--force-embed": "re-embed all documents",
    },
    example: "wiki sync --project myproj",
  },
  session: {
    summary: "Manage the active work session (start, set, show, clear).",
    usage: "wiki session <start|set|show|clear> [flags]",
    example: "wiki session show",
    subverbs: {
      start: {
        summary: "Start a session for a project in the current repo.",
        usage: "wiki session start --project <name> [--phase <phase>] [--active-prd <id>] [--active-slice <id>]",
        flags: {
          "--project": "project name (required)",
          "--phase": "initial phase: plan|prd|slice|red|green|review|close|handover|triage (default: ad-hoc)",
          "--active-prd": "PRD this session is working on",
          "--active-slice": "slice in progress (repeatable)",
        },
        example: "wiki session start --project myproj --phase slice",
      },
      set: {
        summary: "Set a field on the current session (phase, active_prd, active_slices, project).",
        usage: "wiki session set <field> <value>",
        example: "wiki session set phase slice",
      },
      show: {
        summary: "Show the current session context.",
        usage: "wiki session show",
        example: "wiki session show",
      },
      clear: {
        summary: "Clear the current session.",
        usage: "wiki session clear",
        example: "wiki session clear",
      },
    },
  },
  vault: {
    summary: "Vault administration (init, sync, doctor, config).",
    usage: "wiki vault <init|sync|doctor|config> [args]",
    example: "wiki vault doctor",
    subverbs: {
      init: {
        summary: "Initialize a new vault at a path.",
        usage: "wiki vault init <path>",
        example: "wiki vault init ~/Knowledge",
      },
      sync: {
        summary: "Sync vault config and plugins from the manifest into the vault at <path>.",
        usage: "wiki vault sync <path> [--plugin-source <path>]",
        flags: { "--plugin-source": "path to the plugin source dir (optional)" },
        example: "wiki vault sync ~/Knowledge",
      },
      doctor: {
        summary: "Report vault config/plugin/template drift.",
        usage: "wiki vault doctor",
        example: "wiki vault doctor",
      },
      config: {
        summary: "Bless or reset a plugin's config snapshot.",
        usage: "wiki vault config <bless|reset> <plugin>",
        example: "wiki vault config bless dataview",
      },
    },
  },
  project: {
    summary: "Manage projects (create, list).",
    usage: "wiki project <create|list> [name]",
    example: "wiki project create myproj",
    subverbs: {
      create: {
        summary: "Create a new project directory structure under projects/.",
        usage: "wiki project create <name> [--repo <path>] [--test-command <cmd>]",
        flags: {
          "--repo": "path to the code repo this project tracks (default: current directory)",
          "--test-command": "command the TDD gates run (default: bun test)",
        },
        example: "wiki project create myproj --repo ~/code/myproj --test-command 'npm test'",
      },
      list: {
        summary: "List existing projects.",
        usage: "wiki project list",
        example: "wiki project list",
      },
    },
  },
  handover: {
    summary: "Create a handover artifact capturing session state and next-phase routing.",
    usage: "wiki handover [--project <name>] [--phase <phase>] [--next-phase <phase>] [flags]",
    flags: {
      "--project": "project name (required if no active session)",
      "--phase": "current phase (required if no active session)",
      "--next-phase": "phase the next agent should resume in",
      "--active-prd": "PRD this session operated on",
      "--active-slice": "slice in progress (repeatable)",
      "--decision": "decision made this session (repeatable)",
      "--suggested-skill": "skill the next agent should load (repeatable)",
      "--produced": "what this session produced ('-' reads stdin)",
      "--open": "open threads / next steps ('-' reads stdin)",
      "--no-doc": "suppress the auto-printed next-phase guidance",
    },
    example: 'wiki handover --project myproj --next-phase slice --produced "PRD-0006 published"',
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
