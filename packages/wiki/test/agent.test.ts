import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { parse } from "yaml";

const AGENT = new URL("../../../agents/wiki.md", import.meta.url);

test("wiki:19 the Pi agent example has documented frontmatter, stays inactive, and leaves the model configurable", () => {
  const source = fs.readFileSync(AGENT, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(match, "Agent definitions start with YAML frontmatter");
  // pi-subagents 2.9.2 README, Agent definitions / Frontmatter reference.
  // No field is mandatory there; this example explicitly pins its role and inactive state.
  const meta = parse(match[1]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(meta).sort(), ["allow-model-override", "description", "enabled", "name", "session-mode", "system-prompt", "tools"]);
  assert.equal(meta.name, "wiki");
  assert.equal(typeof meta.description, "string");
  assert.ok((meta.description as string).trim());
  assert.equal(meta.enabled, false);
  assert.equal(meta["allow-model-override"], true);
  assert.equal(meta["session-mode"], "standalone");
  assert.equal(meta["system-prompt"], "replace");
  assert.equal(meta.tools, "read,bash,write");
  assert.equal(meta.model, undefined);
  assert.equal(meta["allowed-models"], undefined);
  assert.ok(source.includes("skills/wiki/SKILL.md"), "The skill remains the complete workflow");
});

// A test-only deterministic protocol driver, not an autonomous agent or production
// handoff endpoint. Real CLI, qmd storage and lexical search run without models.
const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
const GUARD = fileURLToPath(new URL("./qmd-cli-guard.js", import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/wiki-handoff.json", import.meta.url), "utf8"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-agent-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;

function parseHandoff(input: unknown) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "Handoff must be an object");
  const allowed = ["vault", "project", "kind", "content", "sources", "limitations", "action", "target", "baseDigest", "contentScope", "ownerDecisions", "knownOpen"];
  for (const key of Object.keys(input)) assert.ok(allowed.includes(key), "Forbidden handoff field: " + key);
  const data = input as Record<string, unknown>;
  function text(key: string) { const value = data[key]; assert.equal(typeof value, "string", key); assert.ok(typeof value === "string" && value.trim(), key); return value; }
  function optional(key: string) { return data[key] == null ? null : text(key); }
  function list(key: string) { const value = data[key]; assert.ok(Array.isArray(value), key); return value.map(item => { assert.ok(typeof item === "string" && item.trim(), key + " accepts distilled strings only"); return item; }); }
  const kind = text("kind");
  assert.ok(["factual", "decision", "policy", "intent", "personal-meaning", "schema"].includes(kind));
  const action = optional("action");
  assert.ok(action === null || action === "proposal" || action === "authorized create" || action === "authorized factual update");
  assert.equal(typeof data.knownOpen, "boolean");
  const baseDigest = optional("baseDigest");
  if (baseDigest !== null) assert.match(baseDigest, /^sha256:[a-f0-9]{64}$/);
  const sources = list("sources"); assert.ok(sources.length, "Source references are required");
  return { vault: text("vault"), project: text("project"), kind, content: text("content"), sources,
    limitations: list("limitations"), action, target: optional("target"), baseDigest,
    contentScope: text("contentScope"), ownerDecisions: list("ownerDecisions"), knownOpen: data.knownOpen };
}

function session(vault: string, mode = "model-free") {
  const callLog = path.join(temp, "qmd-calls-" + ++counter + ".jsonl");
  const calls: { args: string[]; status: number | null }[] = [];
  function cli(args: string[]) {
    const result = spawnSync(process.execPath, ["--import", GUARD, BIN, "--vault", vault, ...args, "--json"], {
      encoding: "utf8", timeout: 30000, cwd: temp,
      env: { ...process.env, HOME: temp, XDG_CACHE_HOME: path.join(temp, "cache"), XDG_CONFIG_HOME: path.join(temp, "config"),
        XDG_DATA_HOME: path.join(temp, "data"), WIKI_VAULT: "", QMD_EMBED_MODEL: "",
        WIKI_QMD_CLI_GUARD: mode, WIKI_QMD_CALL_LOG: callLog, WIKI_QMD_DENY_SUBPROCESS: "1" },
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.stderr, "");
    calls.push({ args, status: result.status });
    return { status: result.status, data: JSON.parse(result.stdout) };
  }
  function ok(args: string[]) { const r = cli(args); assert.equal(r.status, 0, JSON.stringify(r)); assert.equal(r.data.ok, true); return r.data; }
  return { cli, ok, calls };
}

function setup() {
  const vault = path.join(temp, "vault-" + ++counter), s = session(vault);
  s.ok(["init"]);
  const body = path.join(temp, "seed-" + counter + ".md"); fs.writeFileSync(body, fixture.seed.body);
  const created = s.ok(["new", "procedure", "--project", "demo", "--title", fixture.seed.title, "--description", fixture.seed.description, "--body-file", body]);
  const reviewed = s.ok(["show", created.path]);
  const handoff = { ...fixture.handoff, vault, baseDigest: reviewed.digest };
  assert.equal(fixture.handoff.vault, "$DISPOSABLE_VAULT");
  assert.equal(fixture.handoff.baseDigest, "$REVIEWED_BASE_DIGEST");
  return { vault, s, created, reviewed, handoff };
}

// Full byte snapshot: dry-run/proposal must not alter note, log, index, or search state.
function snapshot(dir: string): unknown[] {
  return fs.readdirSync(dir).sort().map(name => {
    const full = path.join(dir, name);
    return [name, fs.statSync(full).isDirectory() ? snapshot(full) : fs.readFileSync(full).toString("base64")];
  });
}

function runProtocol(raw: unknown, topic = { title: "Release checklist", description: "Synthetic release procedure" }, mode = "model-free") {
  const h = parseHandoff(raw), s = session(h.vault, mode);
  // Fast find precedes registry, show and any candidate/write operation.
  const query = topic.title;
  const search = ["find", query, "--terms", query, "--project", h.project];
  let found = s.ok(search);
  if (!found.matches.length) found = s.ok([...search, "--deep"]);
  const registry = s.ok(["type", "list"]);
  assert.ok(JSON.stringify(registry).includes("procedure"));
  const paths = new Set<string>(found.matches.map((m: { path: string }) => m.path));
  if (h.target) paths.add(h.target);
  const reads = [...paths].map(p => s.ok(["show", p]));
  const target = h.target ?? reads[0]?.path;
  const read = reads.find(r => r.path === target);
  const before = snapshot(h.vault);
  const candidate = path.join(temp, "candidate-" + ++counter + ".md");
  // Fixture content is already distilled. This driver makes no semantic judgment.
  fs.writeFileSync(candidate, read ? read.markdown + h.content : h.content);
  const proposal = h.action === null || h.action === "proposal" || h.kind !== "factual" || h.knownOpen ||
    (h.action === "authorized factual update" && (!read || !h.target || !h.baseDigest)) ||
    (read && (h.action !== "authorized factual update" || !h.baseDigest || !h.target));
  if (proposal) {
    const check = read ? s.cli(["update", target, "--expect", h.baseDigest ?? read.digest, "--file", candidate, "--dry-run"]) : null;
    if (check?.status === 3) {
      assert.deepEqual(snapshot(h.vault), before);
      return { outcome: "conflict", path: target, conflict: check.data, candidate,
        checks: [], calls: s.calls, found, limitations: h.limitations };
    }
    if (check) { assert.equal(check.status, 0, JSON.stringify(check)); assert.equal(check.data.outcome, "dry-run"); }
    assert.deepEqual(snapshot(h.vault), before, "Proposal validation changes no vault bytes");
    return { outcome: "proposed", path: target, candidate, checks: check ? [check.data] : [], calls: s.calls, found, limitations: h.limitations };
  }
  const result = read
    ? s.cli(["update", target, "--expect", h.baseDigest!, "--file", candidate])
    : s.cli(["new", "procedure", "--project", h.project, "--title", topic.title, "--description", topic.description, "--body-file", candidate]);
  if (result.status === 3) {
    // Nothing after a conflict: no digest refresh, no new candidate, no retry.
    assert.deepEqual(snapshot(h.vault), before);
    return { outcome: "conflict", path: target, conflict: result.data, candidate, checks: [], calls: s.calls, found, limitations: h.limitations };
  }
  assert.equal(result.status, 0, JSON.stringify(result));
  const checks = [s.ok(["lint", result.data.path]), s.ok(["index", "--check"]), s.ok(["search", "sync"]), s.ok(["lint"])];
  return { outcome: "changed", path: result.data.path, digest: result.data.digest, candidate, checks, calls: s.calls, found, limitations: h.limitations };
}

for (const scenario of fixture.cases) test("wiki:19 synthetic handoff: " + scenario.name, () => {
  const f = setup();
  const handoff = { ...f.handoff, ...scenario.changes };
  if (scenario.interveningEdit) {
    const edited = path.join(temp, "owner-" + ++counter + ".md");
    fs.writeFileSync(edited, f.reviewed.markdown + "2. Owner correction before handoff apply.\n");
    f.s.ok(["update", f.created.path, "--expect", f.reviewed.digest, "--file", edited]);
  }
  const result = runProtocol(handoff, scenario.newTopic);
  assert.equal(result.calls[0]?.args[0], "find", "Search comes first");
  if (scenario.name !== "authorized create") assert.ok(result.calls.some(c => c.args[0] === "show"), "Read relevant existing topics");
  assert.ok(result.calls.some(c => c.args.join(" ") === "type list"));
  assert.deepEqual(result.limitations, fixture.handoff.limitations);
  const updates = result.calls.filter(c => c.args[0] === "update");
  if (scenario.name === "authorized update") {
    assert.equal(result.outcome, "changed"); assert.equal(updates.length, 1);
    assert.equal(updates[0]?.args[3], f.reviewed.digest, "Use the reviewed handoff digest");
    const current = f.s.ok(["show", result.path]);
    assert.equal(current.markdown, f.reviewed.markdown + handoff.content);
    assert.equal(result.digest, current.digest); assert.equal(result.checks.length, 4);
    assert.ok(result.checks.every(c => c.ok));
  } else if (scenario.name === "stale digest") {
    assert.equal(result.outcome, "conflict"); assert.equal(updates.length, 1);
    assert.equal(updates[0]?.status, 3); assert.equal(result.calls.at(-1), updates[0], "Conflict ends execution");
    assert.equal(result.conflict.expected, f.reviewed.digest);
    assert.equal(result.conflict.current, f.s.ok(["show", f.created.path]).digest);
    assert.notEqual(result.conflict.expected, result.conflict.current);
  } else if (scenario.name === "authorized create") {
    assert.equal(result.outcome, "changed"); assert.equal(updates.length, 0);
    assert.equal(result.path, "projects/demo/procedures/rollback-checklist.md");
    assert.ok(result.calls[1]?.args.includes("--deep"), "Deep find follows a miss");
    assert.match(f.s.ok(["show", result.path]).markdown, /synthetic rollback digest/);
  } else {
    assert.equal(result.outcome, "proposed"); assert.ok(fs.existsSync(result.candidate));
    assert.equal(updates.length, 1); assert.ok(updates[0]?.args.includes("--dry-run"));
    assert.equal(f.s.ok(["show", f.created.path]).markdown, f.reviewed.markdown);
  }
});

test("wiki:19 the synthetic handoff boundary rejects transcript, credential and unapproved fields before CLI work", () => {
  const h = setup().handoff;
  for (const key of ["sessionFile", "transcript", "toolDump", "credential", "credentials", "personalMaterial"]) {
    assert.throws(() => runProtocol({ ...h, [key]: "synthetic forbidden material" }), /Forbidden handoff field/);
    assert.throws(() => runProtocol({ ...h, sources: [{ reference: "fixture:source", [key]: "forbidden" }] }), /distilled strings only/);
  }
  for (const field of ["vault", "project", "content", "contentScope", "sources", "limitations", "ownerDecisions"]) {
    const incomplete = { ...h }; delete incomplete[field];
    assert.throws(() => runProtocol(incomplete), "Missing required handoff field " + field);
  }
});

test("wiki:19 incomplete update authority and all owner-reviewed classes yield proposals", () => {
  const f = setup();
  for (const changes of [{ baseDigest: null }, { action: "proposal" }, ...["policy", "intent", "personal-meaning", "schema"].map(kind => ({ kind }))]) {
    const result = runProtocol({ ...f.handoff, ...changes });
    assert.equal(result.outcome, "proposed");
    assert.ok(result.calls.filter(c => c.args[0] === "update").every(c => c.args.includes("--dry-run")));
  }
});


test("wiki:19 deep-only hit is read and proposed under create-only authority, never created", () => {
  const f = setup();
  const candidate = path.join(temp, "deep-hit-" + ++counter + ".md");
  fs.writeFileSync(candidate, f.reviewed.markdown + "2. Use the telescope for the synthetic release.\n");
  f.s.ok(["update", f.created.path, "--expect", f.reviewed.digest, "--file", candidate]);
  // Reuse the existing external-inference seam: expansion adds 'telescope'.
  // Indexing, lexical retrieval, CLI processes, and note reads remain real.
  const model = path.join(temp, "deep-hit-model-" + ++counter + ".gguf");
  fs.writeFileSync(model, "GGUF placeholder; inference is faked, never loaded");
  const config = path.join(f.vault, ".wiki/config.json");
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")),
    search: { models: { embed: model, generate: model, rerank: model } } }) + "\n");
  const topic = { title: "zzzspectrallookup", description: "Synthetic alternate name for the existing topic" };
  const search = session(f.vault, "fake-inference");
  assert.deepEqual(search.ok(["find", topic.title, "--terms", topic.title, "--project", "demo"]).matches, [], "Fast query misses the existing topic");
  const noteBefore = fs.readFileSync(path.join(f.vault, f.created.path));
  const result = runProtocol({ ...f.handoff, action: "authorized create", target: null, baseDigest: null,
    content: "## Steps\n\n1. Synthetic deep-hit finding.\n" }, topic, "fake-inference");
  assert.equal(result.found.mode, "deep", "Use the deep result after the fast miss");
  assert.deepEqual(result.found.matches.map((m: { path: string }) => m.path), [f.created.path]);
  assert.ok(result.calls[1]?.args.includes("--deep"));
  assert.ok(result.calls.some(c => c.args[0] === "show" && c.args[1] === f.created.path), "Read the deep-only match");
  assert.equal(result.outcome, "proposed"); assert.equal(result.path, f.created.path);
  assert.equal(result.calls.filter(c => c.args[0] === "new").length, 0, "An existing deep match must not be created");
  const updates = result.calls.filter(c => c.args[0] === "update");
  assert.equal(updates.length, 1); assert.ok(updates[0]?.args.includes("--dry-run"));
  assert.deepEqual(fs.readFileSync(path.join(f.vault, f.created.path)), noteBefore);
});

test("wiki:19 stale proposal reports one dry-run conflict without retry or note changes", () => {
  const f = setup();
  const candidate = path.join(temp, "stale-proposal-" + ++counter + ".md");
  fs.writeFileSync(candidate, f.reviewed.markdown + "2. Owner correction before proposal validation.\n");
  const owner = f.s.ok(["update", f.created.path, "--expect", f.reviewed.digest, "--file", candidate]);
  const before = fs.readFileSync(path.join(f.vault, f.created.path));
  const result = runProtocol({ ...f.handoff, knownOpen: true });
  assert.equal(result.outcome, "conflict", "Stale proposal returns the conflict instead of a proposal or throw");
  assert.equal(result.path, f.created.path);
  assert.equal(result.conflict.error.code, "conflict");
  assert.equal(result.conflict.expected, f.reviewed.digest); assert.equal(result.conflict.current, owner.digest);
  assert.notEqual(result.conflict.expected, result.conflict.current);
  const updates = result.calls.filter(c => c.args[0] === "update");
  assert.equal(updates.length, 1, "Never retry the stale proposal");
  assert.ok(updates[0]?.args.includes("--dry-run")); assert.equal(updates[0]?.status, 3);
  assert.equal(updates[0]?.args[3], f.reviewed.digest);
  assert.equal(result.calls.at(-1), updates[0], "No protocol commands follow the conflict");
  assert.deepEqual(fs.readFileSync(path.join(f.vault, f.created.path)), before, "Keep the owner's revision unchanged");
});
