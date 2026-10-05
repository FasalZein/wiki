// Pandoc API 1.23 shapes inspected from pandoc 3.8.3. Expected strings are the visible words.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderPandocDocument } from "../src/extract.ts";
import { WikiError } from "../src/types.ts";

describe("pandoc AST text", () => {
  test("emphasis children live on c; link and code children live at c[1]", () => {
    const ast = {
      meta: { title: { t: "MetaInlines", c: [{ t: "Str", c: "Fixture Title" }] } },
      blocks: [
        {
          t: "Para",
          c: [
            { t: "Str", c: "See" },
            { t: "Space" },
            {
              t: "Link",
              c: [
                ["", [], []],
                [
                  {
                    t: "Strong",
                    c: [
                      { t: "Str", c: "the" },
                      { t: "Space" },
                      { t: "Emph", c: [{ t: "Str", c: "source" }] },
                      { t: "Space" },
                      { t: "Str", c: "link" },
                    ],
                  },
                ],
                ["http://example.invalid/next", ""],
              ],
            },
            { t: "Space" },
            { t: "Str", c: "and" },
            { t: "Space" },
            { t: "Code", c: [["", [], []], "kept_code"] },
            { t: "Str", c: "." },
          ],
        },
        {
          t: "Para",
          c: [
            { t: "Emph", c: [{ t: "Str", c: "Emphasis" }, { t: "Space" }, { t: "Str", c: "only" }] },
            { t: "Space" },
            { t: "Str", c: "and" },
            { t: "Space" },
            { t: "Strong", c: [{ t: "Str", c: "strong" }, { t: "Space" }, { t: "Str", c: "only" }] },
          ],
        },
      ],
    };
    const rendered = renderPandocDocument(ast);
    assert.deepEqual(rendered.limitations, []);
    assert.equal(rendered.text, "Fixture Title\nSee the source link and kept_code.\nEmphasis only and strong only");
    assert.equal(rendered.text.includes("example.invalid"), false);
  });

  test("a raw HTML block is an explicit omission and is not executed", () => {
    const ast = {
      meta: {},
      blocks: [
        { t: "Para", c: [{ t: "Str", c: "Visible" }] },
        { t: "RawBlock", c: ["html", "<script>SECRET_SCRIPT</script>"] },
        { t: "Para", c: [{ t: "RawInline", c: ["html", "<iframe src=\"http://127.0.0.1/x\">"] }] },
      ],
    };
    const rendered = renderPandocDocument(ast);
    assert.equal(rendered.text, "Visible");
    assert.deepEqual(rendered.limitations, [
      "omitted RawBlock; raw HTML was not extracted or executed",
      "omitted RawInline; raw HTML was not extracted or executed",
    ]);
    assert.equal(rendered.text.includes("SECRET_SCRIPT"), false);
    assert.equal(JSON.stringify(rendered).includes("127.0.0.1"), false);
  });

  test("figure caption and image alt are text; the image target is not", () => {
    const ast = {
      meta: {},
      blocks: [
        {
          t: "Figure",
          c: [
            ["", [], []],
            [null, [{ t: "Plain", c: [{ t: "Str", c: "Cap" }] }]],
            [
              {
                t: "Plain",
                c: [
                  {
                    t: "Image",
                    c: [["" , [], []], [{ t: "Str", c: "Alt" }, { t: "Space" }, { t: "Str", c: "pixel" }, { t: "Space" }, { t: "Str", c: "label" }], ["http://127.0.0.1/pixel.png", ""]],
                  },
                ],
              },
            ],
          ],
        },
      ],
    };
    const rendered = renderPandocDocument(ast);
    assert.equal(rendered.text, "Cap\nAlt pixel label");
    assert.equal(rendered.text.includes("pixel.png"), false);
  });

  test("an unknown block fails instead of dropping its region", () => {
    assert.throws(
      () => renderPandocDocument({ meta: {}, blocks: [{ t: "DefinitionList", c: [] }] }),
      (error: unknown) => error instanceof WikiError && error.code === "unsupported" && error.message.includes("DefinitionList"),
    );
  });
});
