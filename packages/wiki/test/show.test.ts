import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/wiki.js", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-show-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const TOPIC = "personal/notes/topic.md";
const FRONT = "\uFEFF---\r\ntype: note\r\ntitle: Café\r\ndescription: Current bytes\r\ncreated: 2026-11-06T12:00:00Z\r\n---\r\n";
let counter = 0;
function cli(vault: string, args: string[], human = false) {
  return spawnSync(process.execPath, [BIN, "--vault", vault, ...(human ? [] : ["--json"]), ...args], {
    encoding: "utf8", cwd: temp, env: { ...process.env, HOME: temp, WIKI_VAULT: "" },
  });
}
function fresh(markdown: string) {
  const vault = path.join(temp, String(++counter));
  const init = cli(vault, ["init"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.mkdirSync(path.dirname(path.join(vault, TOPIC)), { recursive: true });
  fs.writeFileSync(path.join(vault, TOPIC), markdown);
  return vault;
}
function show(vault: string, ...args: string[]) {
  const result = cli(vault, ["show", TOPIC, ...args]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
function digest(bytes: string | Buffer) { return "sha256:" + createHash("sha256").update(bytes).digest("hex"); }

test("wiki:06 full show returns exact current UTF-8 Markdown and full-byte digest in JSON and human modes", () => {
  const markdown = FRONT + "# Café\r\n\r\nText with trailing spaces  \r\nNo final newline";
  const vault = fresh(markdown);
  assert.deepEqual(show(vault), { ok: true, path: TOPIC, markdown, digest: digest(markdown) });
  const human = cli(vault, ["show", TOPIC], true);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, markdown);
  assert.equal(human.stderr, "");
});

test("wiki:06 exact rendered heading selects its source subtree through equal or higher headings", () => {
  const selected = "## *Use* &amp; \x60code\x60 [link](https://example.invalid) ![alt](image.png) <em>text</em>\r\n\r\n" +
    "Keep 😀 and trailing spaces  \r\n### Child\r\nNested text\r\n\r\n~~~md\r\n## Stop\r\n~~~\r\n\r\n";
  const markdown = FRONT + "# Root\r\nIntro\r\n" + selected + "## Stop\r\nExcluded\r\n# End\r\n";
  const vault = fresh(markdown);
  const heading = "Use & code link alt text";
  assert.deepEqual(show(vault, "--section", heading), { ok: true, path: TOPIC, section: heading, markdown: selected, digest: digest(markdown) });
  const human = cli(vault, ["show", TOPIC, "--section", heading], true);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, selected);
  assert.equal(show(vault, "--section", "Child").markdown, selected.slice(selected.indexOf("### Child")));
  const last = "Last *section*\r\n------------\r\nNo final newline";
  fs.writeFileSync(path.join(vault, TOPIC), FRONT + "# Root\r\n" + last);
  assert.equal(show(vault, "--section", "Last section").markdown, last);
});

for (const style of ["ATX", "setext"]) for (const human of [false, true]) {
  test("wiki:06 indented " + style + " sections preserve physical line boundaries in " + (human ? "human" : "JSON") + " output", () => {
    for (const newline of ["\r\n", "\n", "\r"]) {
      const selected = (style === "ATX" ? ["  ## Selected", "Body", " ### Nested", "Nested body", ""] : ["  Selected", "  --------", "Body", ""]).join(newline) + newline;
      const next = (style === "ATX" ? ["   ## Next", "Other"] : ["   Next", "   ----", "Other"]).join(newline);
      const markdown = FRONT + "# Root" + newline + selected + next;
      const vault = fresh(markdown);
      const result = cli(vault, ["show", TOPIC, "--section", "Selected"], human);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(result.stderr, "");
      if (human) assert.equal(result.stdout, selected);
      else assert.deepEqual(JSON.parse(result.stdout), { ok: true, path: TOPIC, section: "Selected", markdown: selected, digest: digest(markdown) });
      // A selected final heading starts at body offset zero and retains its indentation at EOF.
      const final = style === "ATX" ? "   ## Last" : "   Last" + newline + "   ----";
      fs.writeFileSync(path.join(vault, TOPIC), FRONT + final);
      const eof = cli(vault, ["show", TOPIC, "--section", "Last"], human);
      assert.equal(eof.status, 0, eof.stderr + eof.stdout);
      assert.equal(eof.stderr, "");
      if (human) assert.equal(eof.stdout, final);
      else assert.deepEqual(JSON.parse(eof.stdout), { ok: true, path: TOPIC, section: "Last", markdown: final, digest: digest(FRONT + final) });
    }
  });
}

function rejected(vault: string, args: string[], status: number, code: string, message: RegExp) {
  const result = cli(vault, args);
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, false);
  assert.equal(data.error.code, code);
  assert.match(data.error.message, message);
}

test("wiki:06 missing and duplicate rendered headings fail explicitly without matching code examples", () => {
  const vault = fresh(FRONT + "# Root\n\n~~~md\n## Example\n~~~\n\n    ## Indented\n\n> ## Quoted\n\n- ## Listed\n\n## **Same**\nFirst\n## Same\nSecond\n");
  for (const heading of ["Missing", "Example", "Indented", "Quoted", "Listed", "same", "**Same**"]) {
    rejected(vault, ["show", TOPIC, "--section", heading], 4, "not_found", /missing requested section/i);
  }
  rejected(vault, ["show", TOPIC, "--section", "Same"], 2, "usage", /duplicate matching headings/i);
  rejected(vault, ["show", "personal/notes/missing.md"], 4, "not_found", /missing requested note/i);
  const human = cli(vault, ["show", TOPIC, "--section", "Missing"], true);
  assert.equal(human.status, 4);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /^not_found: Missing requested section/);
});

test("wiki:06 full digest tracks frontmatter and outside-section whitespace and same-size restored-mtime edits", () => {
  const selected = "## Selected\nKeep this\n";
  const original = FRONT + selected + "## Outside\nText\n";
  const vault = fresh(original);
  const file = path.join(vault, TOPIC);
  const originalStat = fs.statSync(file);
  const first = show(vault, "--section", "Selected");
  const edits = [original.replace("Café", "Cafè"), original + " ", original.replace("Text", "Edit")];
  for (const edited of edits) {
    fs.writeFileSync(file, edited);
    fs.utimesSync(file, originalStat.atime, originalStat.mtime);
    assert.equal(fs.statSync(file).mtimeMs, originalStat.mtime.getTime());
    const current = show(vault, "--section", "Selected");
    assert.equal(current.markdown, selected);
    assert.equal(current.digest, digest(edited));
    assert.notEqual(current.digest, first.digest);
    assert.equal(show(vault).markdown, edited);
  }
  assert.equal(Buffer.byteLength(edits[2] ?? ""), Buffer.byteLength(original));
});

test("wiki:06 unsafe canonical paths and symlinked notes or ancestors are refused", () => {
  const vault = fresh(FRONT + "# Root\n");
  const outside = path.join(temp, "outside.md");
  fs.writeFileSync(outside, "Outside sentinel");
  for (const relative of ["../outside.md", outside, "personal/notes/../notes/topic.md", "personal//notes/topic.md", "./" + TOPIC, "personal\\notes\\topic.md", "personal/%2e%2e/outside.md", "personal/%2Foutside.md", "personal/notes/bad%00.md", ".wiki/config.json", "log.md", "personal/assets/original.md", "personal/notes"]) {
    rejected(vault, ["show", relative], 2, "usage", /canonical|Markdown/i);
  }
  fs.symlinkSync(outside, path.join(vault, "personal/notes/link.md"));
  rejected(vault, ["show", "personal/notes/link.md"], 2, "usage", /symlink/i);
  fs.symlinkSync(path.join(vault, "personal/notes"), path.join(vault, "personal/alias"));
  rejected(vault, ["show", "personal/alias/topic.md"], 2, "usage", /symlink/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "Outside sentinel");
});

test("wiki:06 rejects invalid UTF-8 instead of returning replacement characters or a misleading success", () => {
  const vault = fresh(FRONT + "# Selected\n");
  for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    fs.writeFileSync(path.join(vault, TOPIC), Buffer.concat([Buffer.from(FRONT + "# Selected\n"), invalid]));
    for (const args of [[], ["--section", "Selected"]]) rejected(vault, ["show", TOPIC, ...args], 6, "damaged", /UTF-8/);
  }
  fs.writeFileSync(path.join(vault, TOPIC), "---\ntags: [broken\n---\n# Selected\n");
  rejected(vault, ["show", TOPIC, "--section", "Selected"], 6, "damaged", /Cannot select a section/);
});

test("wiki:06 show and section flags reject incomplete or unrelated command forms", () => {
  const vault = fresh(FRONT + "# Root\n");
  for (const args of [["show"], ["show", TOPIC, "extra"], ["show", TOPIC, "--section"], ["lint", "--section", "Root"], ["init", "--section", "Root"], ["show", TOPIC, "--check"], ["show", TOPIC, "--folder", "notes"]]) {
    rejected(vault, args, 2, "usage", /usage|section|check/i);
  }
});

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      files[path.relative(root, full)] = fs.readFileSync(full).toString("base64");
    }
  }
  return files;
}

test("wiki:06 show reads one actual note without inventory, unrelated validation, writes, network or legacy imports", () => {
  const markdown = FRONT + "# Root\n\n## Selected\nCurrent text\n";
  const vault = fresh(markdown);
  // Deliberately invalid siblings/registry and stale/missing navigation must not block an exact read.
  fs.writeFileSync(path.join(vault, "personal/notes/broken.md"), "---\ntags: [broken\n---\n");
  fs.writeFileSync(path.join(vault, ".wiki/types/note.json"), "{broken");
  fs.unlinkSync(path.join(vault, "index.md"));
  const before = snapshot(vault);
  for (const args of [[], ["--section", "Selected"]]) {
    const result = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./show-io-guard.js", import.meta.url)), BIN, "--vault", vault, "--json", "show", TOPIC, ...args], {
      encoding: "utf8", cwd: temp,
      env: { ...process.env, HOME: temp, WIKI_VAULT: "", WIKI_TEST_ROOT: temp, WIKI_TEST_VAULT: vault, WIKI_TEST_NOTE: TOPIC },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stderr, "");
    const data = JSON.parse(result.stdout);
    assert.equal(data.digest, digest(markdown));
    assert.equal(data.markdown, args.length ? "## Selected\nCurrent text\n" : markdown);
  }
  assert.deepEqual(snapshot(vault), before);
  assert.equal(fs.existsSync(path.join(temp, ".cache")), false);
});
