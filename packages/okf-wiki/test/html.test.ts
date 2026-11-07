import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPandocDocument } from "../src/html.ts";

const doc = (blocks: unknown, meta: unknown = {}) => ({ meta, blocks });
for (const [label, ast] of [
  ["unknown block", doc([{ t: "FutureBlock", c: [] }])],
  ["unknown inline", doc([{ t: "Para", c: [{ t: "FutureInline", c: "lost text" }] }])],
  ["non-list blocks", doc({})],
  ["non-list inlines", doc([{ t: "Para", c: {} }])],
  ["non-string Str", doc([{ t: "Para", c: [{ t: "Str", c: 1 }] }])],
  ["missing Link target", doc([{ t: "Para", c: [{ t: "Link", c: [["", [], []], [{ t: "Str", c: "label" }]] }] }])],
  ["malformed Code attributes", doc([{ t: "Para", c: [{ t: "Code", c: [null, "code"] }] }])],
  ["extra Header region", doc([{ t: "Header", c: [1, ["", [], []], [], "lost text"] }])],
  ["extra Div region", doc([{ t: "Div", c: [["", [], []], [], "lost text"] }])],
  ["malformed RawBlock", doc([{ t: "RawBlock", c: "unknown raw shape" }])],
  ["malformed RawInline", doc([{ t: "Para", c: [{ t: "RawInline", c: "unknown raw shape" }] }])],
  ["unexpected Space payload", doc([{ t: "Para", c: [{ t: "Space", c: "lost text" }] }])],
  ["malformed title", doc([], { title: "lost title" })],
  ["malformed meta", doc([], null)],
  ["missing table fields", doc([{ t: "Table", c: [[], [null, []]] }])],
  ["malformed table cell", doc([{ t: "Table", c: [["", [], []], [null, []], [], [["", [], []], [[["", [], []], [["lost cell"]]]]], [], [["", [], []], []]] }])],
  ["malformed Figure caption", doc([{ t: "Figure", c: [["", [], []], "lost caption", []] }])],
] as const) test("okf:16 Pandoc boundary fails closed: " + label, () => {
  assert.throws(() => renderPandocDocument(ast), /pandoc.*(refusing|not extracted)/);
});

test("okf:16 known raw HTML omissions are explicit limitations, not executable text", () => {
  const rendered = renderPandocDocument(doc([{ t: "RawBlock", c: ["html", "<script>unsafe()</script>"] }, { t: "Para", c: [{ t: "Str", c: "Visible" }, { t: "RawInline", c: ["html", "<i>"] }] }]));
  assert.equal(rendered.text, "Visible");
  assert.deepEqual(rendered.limitations, ["omitted RawBlock; raw HTML was not extracted or executed", "omitted RawInline; raw HTML was not extracted or executed"]);
});
