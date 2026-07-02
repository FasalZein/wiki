import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/cli/dispatch";
import { parseQmdUri } from "../src/integrations/qmd";
import { countArtifactsNewerThanEmbed, markEmbedded } from "../src/artifacts/embed-marker";
import { writeProjectIndex } from "../src/artifacts/index-md";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";

// Fixes batch D (audit F1–F7). In-process dispatch tests (custom-tree-e2e style):
// each test drives a throwaway temp vault via env + dispatch; the real vault is
// never touched. QMD is pinned to a fake so nothing reaches the real index.

const tempPaths: string[] = [];
let prevVaultRoot: string | undefined;
let prevQmd: string | undefined;
const NOOP_QMD = join(import.meta.dir, "fixtures", "noop-qmd.sh");

afterEach(async () => {
  if (prevVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = prevVaultRoot;
  if (prevQmd === undefined) delete process.env.QMD_COMMAND;
  else process.env.QMD_COMMAND = prevQmd;
  prevVaultRoot = undefined;
  prevQmd = undefined;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function capture(): { restore: () => void; out: () => string } {
  const log = console.log;
  const err = console.error;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let buffer = "";
  const sink = (...args: unknown[]) => { buffer += args.map(String).join(" ") + "\n"; };
  const rawSink = ((chunk: string | Uint8Array): boolean => { buffer += chunk.toString(); return true; }) as typeof process.stdout.write;
  console.log = sink;
  console.error = sink;
  // search/emitHits write results via process.stdout.write, not console.log.
  process.stdout.write = rawSink;
  process.stderr.write = rawSink;
  return {
    restore: () => {
      console.log = log;
      console.error = err;
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
    out: () => buffer,
  };
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const cap = capture();
  let code = 0;
  try {
    code = (await dispatch(args)).code;
  } finally {
    cap.restore();
  }
  return { code, out: cap.out() };
}

/** Pin env for a temp vault; QMD defaults to the no-op fake. */
function useVault(vaultRoot: string, qmd = NOOP_QMD): void {
  prevVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;
  prevQmd = process.env.QMD_COMMAND;
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  process.env.QMD_COMMAND = qmd;
}

async function tmpVault(prefix: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(vaultRoot);
  return vaultRoot;
}

async function writeProject(vaultRoot: string, project: string, folders: string[], projectMd = "---\n---\n"): Promise<void> {
  const projPath = join(vaultRoot, "projects", project);
  for (const folder of folders) await mkdir(join(projPath, folder), { recursive: true });
  await writeFile(join(projPath, "_project.md"), `${projectMd}# ${project}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 (F1): templates resolve from the vault first
// ─────────────────────────────────────────────────────────────────────────────

const EPIC_TEMPLATE = `---
template: epic
version: 1
schema:
  id:      { type: string, required: true, pattern: "EPIC-\\\\d{3,}" }
  aliases: { type: list, default: [] }
  title:   { type: string, required: true, min: 5 }
  summary: { type: string, required: true, min: 10 }
  project: { type: string, required: true }
  status:  { type: enum, required: true, values: [open, done], default: open }
  created: { type: date, auto: true }
  updated: { type: date, auto: true }
---
# {{title}}

> {{id}} · {{status}}

{{summary}}

## Details

{{details}}
`;

describe("D1 (F1): a vault-only kind works with the stock binary", () => {
  async function epicVault(): Promise<string> {
    const vaultRoot = await tmpVault("wiki-d1-");
    await writeFile(join(vaultRoot, "wiki.json"), JSON.stringify({ kinds: { epic: { prefix: "EPIC", folder: "epics", dedup: false } } }));
    await mkdir(join(vaultRoot, "templates"), { recursive: true });
    await writeFile(join(vaultRoot, "templates", "epic.md"), EPIC_TEMPLATE);
    await writeProject(vaultRoot, "p", ["epics"]);
    useVault(vaultRoot);
    return vaultRoot;
  }

  test("create/schema/draft all resolve <vaultRoot>/templates/epic.md", async () => {
    const vaultRoot = await epicVault();

    const created = await run(["create", "epic", "--project", "p", "--title", "Payments epic", "--summary", "Ship the payments epic end to end."]);
    expect(created.code).toBe(0);
    const content = await readFile(join(vaultRoot, "projects", "p", "epics", "EPIC-0001-payments-epic.md"), "utf8");
    expect(content).toContain("id: EPIC-0001");
    expect(content).toContain("## Details"); // vault template body applied

    const schema = await run(["schema", "epic"]);
    expect(schema.code).toBe(0);
    expect(schema.out).toContain("epic fields:");
    expect(schema.out).toContain("summary");

    const draft = await run(["draft", "epic", "--project", "p"]);
    expect(draft.code).toBe(0);
    expect(draft.out).toContain("template: epic");
    expect(draft.out).toContain("## Details");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 (F2): dedup local (lexical) scan has its own, stricter scale + short guard
// ─────────────────────────────────────────────────────────────────────────────

describe("D2 (F2): dedup lexical scale is separate and guarded", () => {
  const SHORT = { title: "Cache layer", summary: "Add a cache" };
  const LONG = { title: "Cache invalidation strategy redesign", summary: "Redesign the cache invalidation strategy for correctness" };

  async function decisionVault(project: string, projectMd = "---\n---\n"): Promise<string> {
    const vaultRoot = await tmpVault("wiki-d2-");
    await writeProject(vaultRoot, project, ["adrs"], projectMd);
    useVault(vaultRoot);
    return vaultRoot;
  }

  test("a short title+summary sharing few tokens never trips 'strong' (short-text guard)", async () => {
    await decisionVault("p");
    const first = await run(["create", "decision", "--project", "p", "--title", SHORT.title, "--summary", SHORT.summary]);
    expect(first.code).toBe(0);
    const second = await run(["create", "decision", "--project", "p", "--title", SHORT.title, "--summary", SHORT.summary]);
    expect(second.out).toContain("dedup: possible");
    expect(second.out).not.toContain("dedup: strong");
  });

  test("a long identical title+summary does reach 'strong' under the default lexical pair", async () => {
    await decisionVault("p");
    await run(["create", "decision", "--project", "p", "--title", LONG.title, "--summary", LONG.summary]);
    const second = await run(["create", "decision", "--project", "p", "--title", LONG.title, "--summary", LONG.summary]);
    expect(second.out).toContain("dedup: strong");
  });

  test("the lexical strong threshold is independently configurable (raising it downgrades the same match)", async () => {
    // Same LONG identical pair, but dedup_lexical_strong is set unreachably high in
    // _project.md — proving the local scan reads its OWN threshold, not the qmd one.
    await decisionVault("p", "---\ndedup_lexical_strong: 1.1\n---\n");
    await run(["create", "decision", "--project", "p", "--title", LONG.title, "--summary", LONG.summary]);
    const second = await run(["create", "decision", "--project", "p", "--title", LONG.title, "--summary", LONG.summary]);
    expect(second.out).toContain("dedup: possible");
    expect(second.out).not.toContain("dedup: strong");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 (F4): embedding staleness surfaced at search
// ─────────────────────────────────────────────────────────────────────────────

/** A fake qmd that reports project `p` as an existing collection (so search does
 *  not skip it), returns no query hits, and no-ops update/embed with a clean exit. */
const LIST_P_QMD = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  collection) [ "\${2:-}" = "list" ] && echo "qmd://p/" || : ;;
  query) echo '[]' ;;
  *) : ;;
esac
`;

describe("D3 (F4): search surfaces embedding staleness", () => {
  test("marker unit: newer-than-embed count flips with the marker", async () => {
    const { utimes } = await import("node:fs/promises");
    const vaultRoot = await tmpVault("wiki-d3u-");
    const projPath = join(vaultRoot, "projects", "p");
    await mkdir(join(projPath, "adrs"), { recursive: true });
    await writeFile(join(projPath, "_project.md"), "---\n---\n# p\n");
    const artifact = join(projPath, "adrs", "ADR-0001-x.md");
    await writeFile(artifact, "---\nid: ADR-0001\ntitle: X\n---\n# X\n");
    await markEmbedded(projPath);
    const marker = join(projPath, ".last-embed");
    const base = Date.now();
    const at = (ms: number) => new Date(base + ms);

    // marker newer than the artifact → nothing stale
    await utimes(artifact, at(0), at(0));
    await utimes(marker, at(1000), at(1000));
    expect(await countArtifactsNewerThanEmbed(vaultRoot, projPath, DEFAULT_STRUCTURE)).toBe(0);

    // artifact written after the embed → one stale
    await utimes(artifact, at(5000), at(5000));
    expect(await countArtifactsNewerThanEmbed(vaultRoot, projPath, DEFAULT_STRUCTURE)).toBe(1);

    // re-embed (marker newest again) → cleared
    await utimes(marker, at(10000), at(10000));
    expect(await countArtifactsNewerThanEmbed(vaultRoot, projPath, DEFAULT_STRUCTURE)).toBe(0);
  });

  test("write after sync → search warns; sync again → warning gone", async () => {
    const vaultRoot = await tmpVault("wiki-d3-");
    const fakeQmd = join(vaultRoot, "fake-qmd.sh");
    await writeFile(fakeQmd, LIST_P_QMD);
    await chmod(fakeQmd, 0o755);
    await writeProject(vaultRoot, "p", ["adrs"]);
    useVault(vaultRoot, fakeQmd);

    await run(["create", "decision", "--project", "p", "--title", "First decision", "--summary", "The first decision summary."]);
    expect((await run(["sync", "--project", "p"])).code).toBe(0);

    // Nothing written since the sync → no staleness note.
    const clean = await run(["search", "anything", "--project", "p"]);
    expect(clean.out).not.toContain("newer than the last sync");

    await new Promise((r) => setTimeout(r, 20));
    await run(["create", "decision", "--project", "p", "--title", "Second decision", "--summary", "The second decision summary."]);

    const stale = await run(["search", "anything", "--project", "p"]);
    expect(stale.out).toContain("newer than the last sync");
    expect(stale.out).toContain("wiki sync --project p");

    await new Promise((r) => setTimeout(r, 20));
    expect((await run(["sync", "--project", "p"])).code).toBe(0);
    const cleared = await run(["search", "anything", "--project", "p"]);
    expect(cleared.out).not.toContain("newer than the last sync");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 (F3): fmt drives its checks from the template, not string literals
// ─────────────────────────────────────────────────────────────────────────────

describe("D4 (F3): fmt narrative/guidance checks generalize beyond decision/prd", () => {
  test("a handoff (not decision, not prd) is flagged for narrative-in-frontmatter and guidance-only body", async () => {
    const vaultRoot = await tmpVault("wiki-d4-");
    await writeProject(vaultRoot, "p", ["handoffs"]);
    useVault(vaultRoot);
    const handoff = [
      "---",
      "id: HANDOFF-0001",
      "aliases: [HANDOFF-0001]",
      "project: p",
      "title: A session",
      "summary: A session summary that is long enough.",
      "session_date: '2026-01-01'",
      "phase: plan",
      "status: open",
      "produced: This prose belongs in the body, not frontmatter.", // authored placeholder in frontmatter
      "---",
      "# Handoff",
      "",
      "## Pointers",
      "",
      "> Replace with real pointers.", // guidance-only section
      "",
    ].join("\n");
    await writeFile(join(vaultRoot, "projects", "p", "handoffs", "HANDOFF-0001-a-session.md"), handoff);

    const check = await run(["fmt", "--project", "p"]);
    expect(check.out).toContain("narrative stored in frontmatter (produced)");
    expect(check.out).toContain("only template guidance");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 (F5): qmd:// parsed once in the adapter
// ─────────────────────────────────────────────────────────────────────────────

describe("D5 (F5): parseQmdUri is the single URI parser", () => {
  test("parses a qmd:// URI into collection + rel, and degrades on a raw path", () => {
    expect(parseQmdUri("qmd://wiki-v2/docs/DOC-0017.md")).toEqual({ collection: "wiki-v2", rel: "docs/DOC-0017.md" });
    expect(parseQmdUri("qmd://coll")).toEqual({ collection: "coll", rel: "" });
    expect(parseQmdUri("/abs/path/to/file.md")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D6 (F6): qmd subprocess hygiene — nonzero embed fails the sync
// ─────────────────────────────────────────────────────────────────────────────

const FAIL_EMBED_QMD = `#!/usr/bin/env bash
case "\${1:-}" in
  collection) [ "\${2:-}" = "list" ] && echo "qmd://p/" || exit 0 ;;
  update) exit 0 ;;
  embed) echo "embedded 2 of 3 files"; exit 1 ;;  # nonzero WITH stdout — must still fail
  query) echo '[]' ;;
  *) exit 0 ;;
esac
`;

const PARTIAL_QUERY_QMD = `#!/usr/bin/env bash
case "\${1:-}" in
  collection) [ "\${2:-}" = "list" ] && echo "qmd://p/" || exit 0 ;;
  query) echo '[{"path":"qmd://p/adrs/ADR-0001-x.md","score":0.9,"snippet":"hit"}]'; exit 1 ;;  # partial + nonzero
  *) exit 0 ;;
esac
`;

describe("D6 (F6): a failed embed fails the sync; query keeps partial results", () => {
  test("sync reports failure and stamps no marker when embed exits nonzero (even with stdout)", async () => {
    const vaultRoot = await tmpVault("wiki-d6-");
    const fakeQmd = join(vaultRoot, "fail-embed.sh");
    await writeFile(fakeQmd, FAIL_EMBED_QMD);
    await chmod(fakeQmd, 0o755);
    await writeProject(vaultRoot, "p", ["adrs"]);
    useVault(vaultRoot, fakeQmd);

    const synced = await run(["sync", "--project", "p"]);
    expect(synced.code).not.toBe(0);
    // no last-embed marker was written — the embed failed before the stamp
    await expect(stat(join(vaultRoot, "projects", "p", ".last-embed"))).rejects.toBeDefined();
  });

  test("query tolerates a nonzero exit that still printed results (partial beats none)", async () => {
    const vaultRoot = await tmpVault("wiki-d6q-");
    const fakeQmd = join(vaultRoot, "partial-query.sh");
    await writeFile(fakeQmd, PARTIAL_QUERY_QMD);
    await chmod(fakeQmd, 0o755);
    await writeProject(vaultRoot, "p", ["adrs"]);
    useVault(vaultRoot, fakeQmd);

    const searched = await run(["search", "anything", "--project", "p"]);
    expect(searched.code).toBe(0);
    expect(searched.out).toContain("ADR-0001");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D7 (F7): index.md surfaces unknown-prefix ids and caches them
// ─────────────────────────────────────────────────────────────────────────────

describe("D7 (F7): unknown-kind ids land in a trailer and are cached", () => {
  test("an id whose prefix is no registered kind is listed and reused from cache", async () => {
    const vaultRoot = await tmpVault("wiki-d7-");
    const projPath = join(vaultRoot, "projects", "p");
    await mkdir(join(projPath, "widgets"), { recursive: true });
    await writeFile(join(projPath, "_project.md"), "---\n---\n# p\n");
    // WIDGET is not a default kind → typeForId is undefined.
    await writeFile(join(projPath, "widgets", "WIDGET-0001-x.md"), "---\nid: WIDGET-0001\ntitle: A widget\n---\n# A widget\n");

    const first = await writeProjectIndex(vaultRoot, "p", DEFAULT_STRUCTURE);
    expect(first.parsed).toBeGreaterThanOrEqual(1);
    const index = await readFile(join(projPath, "index.md"), "utf8");
    expect(index).toContain("## Unrecognized kind");
    expect(index).toContain("widgets/WIDGET-0001-x.md (id WIDGET-0001 — prefix not a registered kind)");
    expect(index).not.toContain("[[WIDGET-0001]]"); // never a roster row

    // A second regen with no mtime change reuses the cached record (not re-parsed).
    const second = await writeProjectIndex(vaultRoot, "p", DEFAULT_STRUCTURE);
    expect(second.reused).toBeGreaterThanOrEqual(1);
    expect(second.parsed).toBe(0);
    const index2 = await readFile(join(projPath, "index.md"), "utf8");
    expect(index2).toContain("widgets/WIDGET-0001-x.md (id WIDGET-0001 — prefix not a registered kind)");
  });
});
