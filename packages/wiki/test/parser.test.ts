import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNoteText } from "../src/frontmatter.ts";

test("wiki:02 malformed and executable YAML remains invalid on repeated reads in one process", () => {
  for (const text of [
    "---\ntags: [broken\n---\nbody\n",
    '---\nfunction: !!js/function "function () { return 42; }"\n---\nbody\n',
    "---\nvalue: !unsafe data\n---\n",
    "---js\nprocess.exit(99)\n---\n",
    "---\n- sequence\n---\n",
    "---\ntitle: First\ntitle: Duplicate\n---\n",
  ]) {
    assert.throws(() => parseNoteText(text), /YAML|mapping|delimiter/);
    assert.throws(() => parseNoteText(text), /YAML|mapping|delimiter/);
  }
});

test("wiki:02 safe parser preserves timestamp strings and body bytes without Date coercion", () => {
  const parsed = parseNoteText('\uFEFF---\r\ncreated: 2026-11-06\r\ntitle: 2026-11-06T12:00:00Z\r\n---\r\nBody\r\n');
  assert.equal(parsed.frontmatter.created, "2026-11-06");
  assert.equal(parsed.frontmatter.title, "2026-11-06T12:00:00Z");
  assert.equal(parsed.body, "Body\r\n");
});
