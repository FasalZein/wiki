import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { spawnCli } from "./cli-helper.ts";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// The repository skill is the contract under test: its commands are parsed from SKILL.md
// and run as real CLI processes against disposable vaults. Only model inference is faked
// (qmd-cli-guard.js fake-inference mode); qmd indexing and lexical retrieval stay real.
const GUARD = fileURLToPath(new URL("./qmd-cli-guard.js", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SKILL_DIR = path.join(REPO, "skills/wiki");
const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-skill-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;

/** Splits one documented command line into words; double quotes group words. */
function words(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(match[1] ?? match[2] ?? "");
  return out;
}
/** Every `wiki ...` line inside fenced code blocks, in document order. */
const COMMANDS: string[][] = (() => {
  const found: string[][] = [];
  let fenced = false;
  for (const raw of SKILL.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (fenced && line.startsWith("wiki ")) found.push(words(line).slice(1));
  }
  return found;
})();
/** The subcommand words of a documented command, without global flags. */
function verb(args: string[]): string {
  const rest = args[0] === "--vault" ? args.slice(2) : args;
  return ["type", "search"].includes(rest[0] ?? "") ? rest.slice(0, 2).join(" ") : rest[0] ?? "";
}
const flags = (args: string[]) => args.filter(word => word.startsWith("--"));

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const log = path.join(temp, "calls-" + (++counter) + ".jsonl");
  const search = ["find", "search"].includes(args.find(word => !word.startsWith("-") && !word.startsWith("/")) ?? "");
  const result = spawnCli([...args], {
    imports: [GUARD], timeout: 30000,
    env: { ...process.env, HOME: temp, XDG_CACHE_HOME: path.join(temp, "cache"), XDG_CONFIG_HOME: path.join(temp, "config"), XDG_DATA_HOME: path.join(temp, "data"), WIKI_VAULT: "", QMD_EMBED_MODEL: "", WIKI_QMD_CLI_GUARD: "fake-inference", WIKI_QMD_CALL_LOG: log, ...(search ? { WIKI_QMD_DENY_SUBPROCESS: "1" } : {}), ...extraEnv },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, "", args.join(" "));
  const ops = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => (JSON.parse(line) as { op: string }).op) : [];
  return { status: result.status, data: JSON.parse(result.stdout), ops };
}
function ok(args: string[]) { const result = cli(args); assert.equal(result.status, 0, args.join(" ") + "\n" + JSON.stringify(result.data)); return result.data; }
const sha = (file: string) => "sha256:" + createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const SEED_BODY = "## Steps\n\n1. Read src/app.ts before the seeded release.\n";
type Fixture = { vault: string; seeded: string; personal: string };
/** A disposable vault with one project topic and one personal topic. Models are placeholder files. */
function fixture(models = true): Fixture {
  const vault = path.join(temp, "vault-" + (++counter));
  ok(["init", vault, "--json"]);
  if (models) {
    const configured: Record<string, string> = {};
    for (const role of ["embed", "generate", "rerank"]) {
      configured[role] = path.join(temp, "model-" + counter + "-" + role + ".gguf");
      fs.writeFileSync(configured[role], "GGUF placeholder");
    }
    const config = path.join(vault, ".wiki/config.json");
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), search: { models: configured } }, null, 2) + "\n");
  }
  const body = path.join(temp, "seed-" + counter + ".md");
  fs.writeFileSync(body, SEED_BODY);
  const seeded = ok(["--vault", vault, "new", "procedure", "--project", "demo", "--title", "Seeded release", "--description", "Seeded release steps", "--body-file", body, "--json"]).path as string;
  const personal = ok(["--vault", vault, "new", "note", "--personal", "--title", "Seeded thought", "--description", "Seeded personal release thought", "--json"]).path as string;
  return { vault, seeded, personal };
}
/** Fixture values for every placeholder the skill uses. An unknown placeholder fails the test. */
function bindings(f: Fixture, args: string[]): Record<string, string> {
  const n = ++counter;
  const body = path.join(temp, "body-" + n + ".md"); fs.writeFileSync(body, "## Steps\n\n1. Fresh step.\n");
  const candidate = path.join(temp, "candidate-" + n + ".md");
  fs.writeFileSync(candidate, fs.readFileSync(path.join(f.vault, f.seeded), "utf8") + "2. Confirm the release digest.\n");
  const source = path.join(temp, "source-" + n + ".md"); fs.writeFileSync(source, "# Upstream\n\nCaptured release text.\n");
  const addingType = verb(args) === "type add";
  return {
    vault: f.vault, dir: path.join(temp, "init-" + n), project: "demo", type: "procedure", folder: addingType ? "runbooks" : "procedures",
    name: "runbook", question: "seeded release", keywords: "seeded release", n: "5", path: f.seeded, heading: "Steps",
    digest: sha(path.join(f.vault, f.seeded)), "base-digest": sha(path.join(f.vault, f.seeded)), candidate, title: "Fresh topic", description: "Fresh topic description",
    "body-file": body, slug: "fresh-topic", tag: "release", status: "draft", "file-or-url": source,
  };
}
function bind(args: string[], values: Record<string, string>): string[] {
  return args.map(word => word.replace(/<([a-z-]+)>/g, (_all, key: string) => {
    assert.ok(key in values, "Unbound skill placeholder <" + key + ">"); return values[key] as string;
  }));
}
function cleanVault(vault: string) {
  assert.equal(ok(["--vault", vault, "lint", "--json"]).ok, true);
  assert.equal(ok(["--vault", vault, "index", "--check", "--json"]).ok, true);
}

/** Behaviour each documented command must show, judged against the CLI contract the skill states. */
function expectDocumented(args: string[], f: Fixture, values: Record<string, string>) {
  const label = args.join(" ");
  const seededFile = path.join(f.vault, f.seeded);
  const before = fs.readFileSync(seededFile);
  const result = cli(bind(args, values));
  const { data } = result;
  const has = (flag: string) => args.includes(flag);
  switch (verb(args)) {
    case "init":
      assert.equal(result.status, 0, label); assert.ok(fs.existsSync(path.join(values.dir as string, ".wiki/config.json")), label); break;
    case "doctor": {
      // Before the first search sync, search is uninspectable: exit 7. After it, a ready vault exits 0.
      assert.equal(result.status, 7, label + JSON.stringify(data)); assert.equal(data.search.database.state, "unavailable");
      ok(["--vault", f.vault, "search", "sync", "--json"]);
      const ready = cli(bind(args, values));
      assert.equal(ready.status, 0, label + JSON.stringify(ready.data)); assert.equal(ready.data.sourceCorrectness, "not-asserted");
      assert.equal(ready.data.search.textCoverage.state, "complete"); assert.equal(ready.data.search.embeddingCoverage.state, "incomplete", "Pending embeddings are reported separately");
      assert.deepEqual(fs.readFileSync(seededFile), before, "doctor repairs and rewrites nothing");
      break;
    }
    case "type list":
      assert.equal(result.status, 0, label); assert.ok(JSON.stringify(data).includes("procedure"), label); break;
    case "type add":
      assert.equal(result.status, 0, label + JSON.stringify(data)); assert.ok(fs.existsSync(path.join(f.vault, ".wiki/types/runbook.json")), label); cleanVault(f.vault); break;
    case "show": {
      assert.equal(result.status, 0, label + JSON.stringify(data));
      const target = path.join(f.vault, data.path as string);
      assert.equal(data.digest, sha(target), "The digest covers the whole file: " + label);
      if (has("--section")) { assert.equal(data.section, "Steps"); assert.match(data.markdown, /^## Steps\n/); assert.ok(!data.markdown.includes("title:"), label); }
      else assert.equal(data.markdown, fs.readFileSync(target, "utf8"), label);
      if (data.path.endsWith("/procedures/index.md")) assert.ok(data.markdown.includes("Seeded release"), "A type-folder index lists its topics");
      else if (data.path.endsWith("/index.md")) assert.ok(data.markdown.includes("procedures/index.md"), "A scope index links its type folders");
      break;
    }
    case "find": {
      assert.equal(result.status, 0, label + JSON.stringify(data));
      assert.equal(data.mode, has("--deep") ? "deep" : "fast", label); assert.equal(data.rerank, has("--deep"), label);
      assert.equal(result.ops.includes("expandQuery"), has("--deep"), "Only --deep expands: " + label);
      assert.ok(["complete", "incomplete", "unavailable"].includes(data.textCoverage.state) && ["complete", "incomplete", "unavailable"].includes(data.embeddingCoverage.state), label);
      assert.equal(data.degraded, undefined, "Configured models give non-degraded results: " + label);
      if (has("--limit")) assert.equal(data.limit, 5); else assert.equal(data.limit, 10, "The documented default limit");
      const expected = has("--personal") ? f.personal : f.seeded;
      // The fake deep expansion replaces the lexical query with a fixed word, so only fast find can be held to recall.
      if (!has("--deep")) assert.ok(data.matches.some((m: { path: string }) => m.path === expected), label + JSON.stringify(data.matches));
      for (const m of data.matches as { scope: string; type: string; digest: string; path: string }[]) {
        assert.equal(m.scope, has("--personal") ? "personal" : "projects/demo", label);
        if (has("--type")) assert.equal(m.type, "procedure", label);
        assert.equal(m.digest, sha(path.join(f.vault, m.path)), label);
      }
      break;
    }
    case "search sync":
      if (has("--embed")) {
        // Fake inference embeds nothing, so the waited embed must report pending coverage as unavailable (exit 7).
        assert.ok(result.ops.includes("embed"), "--embed runs embedding synchronously");
        assert.equal(result.status, 7, label); assert.equal(data.textCoverage.state, "complete"); assert.equal(data.embeddingCoverage.state, "incomplete");
      } else {
        assert.equal(result.status, 0, label); assert.equal(data.textCoverage.state, "complete"); assert.equal(result.ops.includes("embed"), false, "Plain sync never embeds");
      }
      break;
    case "new":
      assert.equal(result.status, 0, label + JSON.stringify(data)); assert.equal(data.digest, sha(path.join(f.vault, data.path)), label);
      assert.ok(data.path.startsWith(has("--personal") ? "personal/" : "projects/demo/"), label);
      if (has("--slug")) assert.ok(data.path.endsWith("/fresh-topic.md"), label);
      if (has("--status")) assert.match(fs.readFileSync(path.join(f.vault, data.path), "utf8"), /status: "draft"/);
      cleanVault(f.vault);
      assert.equal(cli(bind(args, values)).status, 3, "A repeated create is a conflict: " + label);
      break;
    case "update":
      assert.equal(result.status, 0, label + JSON.stringify(data));
      if (has("--dry-run")) {
        assert.equal(data.outcome, "dry-run"); assert.deepEqual(fs.readFileSync(seededFile), before, "A dry-run leaves the note unchanged");
      } else {
        assert.equal(data.outcome, "updated"); assert.equal(fs.readFileSync(seededFile, "utf8"), fs.readFileSync(values.candidate as string, "utf8"));
        assert.equal(data.digest, sha(seededFile)); cleanVault(f.vault);
        const stale = cli(bind(args, values));
        assert.equal(stale.status, 3, "The old digest is now stale"); assert.equal(stale.data.error.code, "conflict");
        assert.equal(stale.data.expected, values["base-digest"]); assert.equal(stale.data.current, sha(seededFile));
      }
      break;
    case "capture":
      assert.equal(result.status, 0, label + JSON.stringify(data)); assert.ok(fs.existsSync(path.join(f.vault, data.path)), label); cleanVault(f.vault); break;
    case "lint": case "index":
      assert.equal(result.status, 0, label + JSON.stringify(data)); assert.equal(data.ok, true, label); break;
    default:
      assert.fail("The skill documents an untested command: " + label);
  }
}

test("wiki:18 the skill is one SKILL.md with valid Agent Skills metadata and no hooks file", () => {
  assert.deepEqual(fs.readdirSync(SKILL_DIR), ["SKILL.md"]);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
  assert.ok(match, "SKILL.md starts with YAML frontmatter");
  const meta = parse(match[1] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(meta).sort(), ["description", "name"]);
  assert.equal(meta.name, "wiki", "The name matches the skill directory");
  assert.match(meta.name as string, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(typeof meta.description, "string");
  const description = meta.description as string;
  assert.ok(description.trim().length > 0 && description.length <= 1024, "Agent Skills description is 1-1024 characters");
  const references = spawnSync("git", ["grep", "--untracked", "-l", "hooks\\.md", "--", ".", ":!packages/wiki/test/skill.test.ts"], { cwd: REPO, encoding: "utf8" });
  assert.equal(references.status, 1, "No repository file references hooks.md: " + references.stdout);
});

test("wiki:18 every command and flag the skill names is a documented command the test runs", () => {
  const verbs = new Set(COMMANDS.map(verb));
  for (const required of ["init", "doctor", "type list", "type add", "show", "find", "search sync", "new", "update", "capture", "lint", "index"]) assert.ok(verbs.has(required), "Skill teaches " + required);
  const runFlags = new Set(COMMANDS.flatMap(flags));
  for (const required of ["--section", "--terms", "--deep", "--project", "--personal", "--type", "--limit", "--embed", "--expect", "--file", "--dry-run", "--check", "--body-file", "--slug", "--tags", "--status", "--folder", "--title", "--description", "--vault", "--json"]) assert.ok(runFlags.has(required), "Skill runs " + required);
  // A flag named anywhere in the prose must also appear in a command that the next test executes.
  for (const flag of new Set(SKILL.match(/--[a-z][a-z-]*/g) ?? [])) assert.ok(runFlags.has(flag), "Prose flag without a runnable command: " + flag);
});

test("wiki:18 each documented skill command runs against a disposable vault and behaves as the skill states", () => {
  assert.ok(COMMANDS.length >= 20, "Parsed " + COMMANDS.length + " commands");
  for (const args of COMMANDS) {
    const f = fixture();
    expectDocumented(args, f, bindings(f, args));
  }
});

test("wiki:18 an authorized update passes the handoff base digest: after another edit it exits 3 and leaves the note unchanged", () => {
  const f = fixture(false);
  const file = path.join(f.vault, f.seeded);
  // The working agent reviewed this revision and hands its digest over.
  const handoffDigest = ok(["--vault", f.vault, "show", f.seeded, "--json"]).digest as string;
  // The owner edits the note before the wiki agent applies the handoff.
  const ownerEdit = path.join(temp, "owner-" + (++counter) + ".md");
  fs.writeFileSync(ownerEdit, fs.readFileSync(file, "utf8") + "2. Owner correction.\n");
  ok(["--vault", f.vault, "update", f.seeded, "--expect", handoffDigest, "--file", ownerEdit, "--json"]);
  const ownerBytes = fs.readFileSync(file);
  // The wiki agent reads the note to build its candidate, then applies with the handoff digest, as the skill states.
  const [documented] = COMMANDS.filter(args => verb(args) === "update" && !args.includes("--dry-run"));
  assert.ok(documented?.includes("<base-digest>"), "The skill passes the handoff base digest to --expect");
  const candidate = path.join(temp, "agent-" + (++counter) + ".md");
  fs.writeFileSync(candidate, ok(["--vault", f.vault, "show", f.seeded, "--json"]).markdown + "3. Agent finding.\n");
  const stale = cli(bind(documented as string[], { vault: f.vault, path: f.seeded, "base-digest": handoffDigest, candidate }));
  assert.equal(stale.status, 3, JSON.stringify(stale.data)); assert.equal(stale.data.error.code, "conflict");
  assert.equal(stale.data.expected, handoffDigest); assert.equal(stale.data.current, sha(file));
  assert.deepEqual(fs.readFileSync(file), ownerBytes, "The owner's revision stays unchanged");
});

test("wiki:18 search results read as the skill states: degraded lexical misses are not exhaustive and literal tokens match note text", () => {
  const f = fixture(false);
  const found = ok(["--vault", f.vault, "find", "where is src/app.ts used?", "--project", "demo", "--json"]);
  assert.equal(found.degraded.retrieval, "lexical"); assert.equal(found.degraded.exhaustive, false);
  assert.equal(found.textCoverage.state, "complete"); assert.equal(found.embeddingCoverage.state, "unavailable");
  assert.equal(found.matches[0].path, f.seeded); assert.deepEqual(found.matches[0].literal, ["src/app.ts"]);
  const miss = ok(["--vault", f.vault, "find", "zzzabsentword", "--json"]);
  assert.deepEqual(miss.matches, []); assert.equal(miss.degraded.exhaustive, false, "A degraded miss is not an absence claim");
});
