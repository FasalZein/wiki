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
] as const) test("wiki:16 Pandoc boundary fails closed: " + label, () => {
  assert.throws(() => renderPandocDocument(ast), /pandoc.*(refusing|not extracted)/);
});

for (const [label, ast] of [
  ["non-object inline", doc([{ t: "Para", c: [null] }])],
  ["non-text Code", doc([{ t: "Para", c: [{ t: "Code", c: [["", [], []], 7] }] }])],
  ["invalid quote type", doc([{ t: "Para", c: [{ t: "Quoted", c: [{ t: "OtherQuote" }, []] }] }])],
  ["non-object block", doc([null])],
  ["non-integer Header", doc([{ t: "Header", c: ["1", ["", [], []], []] }])],
  ["non-text CodeBlock", doc([{ t: "CodeBlock", c: [["", [], []], 7] }])],
  ["non-object title", doc([], { title: null })],
  ["unsupported title", doc([], { title: { t: "MetaBool", c: true } })],
] as const) test("wiki:16 renderer rejects invalid node shapes: " + label, () => {
  assert.throws(() => renderPandocDocument(ast), /pandoc.*(refusing|not extracted)/);
});

test("wiki:16 inline shapes preserve text and whitespace without link targets", () => {
  const word = [{ t: "Str", c: "word" }];
  const attr = ["", [], []];
  const inlines = [
    { t: "Code", c: [attr, "code"] }, { t: "Space" },
    ...["Emph", "Strong", "Underline", "Strikeout", "Superscript", "Subscript", "SmallCaps"].map(t => ({ t, c: word })),
    { t: "SoftBreak" }, { t: "LineBreak" },
    ...["Link", "Image"].map(t => ({ t, c: [attr, word, ["https://unused.invalid", "unused"]] })),
    { t: "Span", c: [attr, word] },
    { t: "Quoted", c: [{ t: "SingleQuote" }, word] },
    { t: "Quoted", c: [{ t: "DoubleQuote" }, word] },
  ];
  assert.equal(renderPandocDocument(doc([{ t: "Para", c: inlines }])).text,
    "code " + "word".repeat(7) + "\n\n" + "word".repeat(5));
});

test("wiki:16 block shapes and title forms preserve text and line endings", () => {
  const attr = ["", [], []];
  const word = [{ t: "Str", c: "word" }];
  const plain = [{ t: "Plain", c: word }];
  const blocks = [
    { t: "Header", c: [1, attr, word] },
    { t: "CodeBlock", c: [attr, "code\n"] },
    { t: "CodeBlock", c: [attr, "tail"] },
    { t: "BlockQuote", c: plain }, { t: "Div", c: [attr, plain] },
    { t: "BulletList", c: [plain] }, { t: "OrderedList", c: [[1, {}, {}], [plain]] },
    { t: "LineBlock", c: [word] }, { t: "HorizontalRule" },
  ];
  for (const title of [{ t: "MetaString", c: "Title" }, { t: "MetaInlines", c: [{ t: "Str", c: "Title" }] }, { t: "MetaBlocks", c: [{ t: "Plain", c: [{ t: "Str", c: "Title" }] }] }]) {
    assert.equal(renderPandocDocument(doc(blocks, { title })).text, "Title\nword\ncode\ntail\nword\nword\nword\nword\nword");
  }
});

test("wiki:16 known raw HTML omissions are explicit limitations, not executable text", () => {
  const rendered = renderPandocDocument(doc([{ t: "RawBlock", c: ["html", "<script>unsafe()</script>"] }, { t: "Para", c: [{ t: "Str", c: "Visible" }, { t: "RawInline", c: ["html", "<i>"] }] }]));
  assert.equal(rendered.text, "Visible");
  assert.deepEqual(rendered.limitations, ["omitted RawBlock; raw HTML was not extracted or executed", "omitted RawInline; raw HTML was not extracted or executed"]);
});
