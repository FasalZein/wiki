import { describe, expect, test } from "bun:test";
import { parseQmdResults, QmdError } from "../src/integrations/qmd";

describe("parseQmdResults", () => {
  test("parses a valid array of results", () => {
    const out = JSON.stringify([{ path: "a.md", snippet: "hi", score: 0.9 }]);
    expect(parseQmdResults(out)).toEqual([{ path: "a.md", snippet: "hi", score: "0.9" }]);
  });

  test("field fallbacks: file, filename, none-dropped", () => {
    const out = JSON.stringify([
      { file: "b.md" },
      { filename: "c.md" },
      { score: 1 },
    ]);
    expect(parseQmdResults(out)).toEqual([
      { path: "b.md", snippet: "", score: "" },
      { path: "c.md", snippet: "", score: "" },
    ]);
  });

  test("score handled as string or number; text fallback for snippet", () => {
    const out = JSON.stringify([
      { path: "a.md", text: "body", score: "0.5" },
      { path: "b.md", score: 2 },
    ]);
    expect(parseQmdResults(out)).toEqual([
      { path: "a.md", snippet: "body", score: "0.5" },
      { path: "b.md", snippet: "", score: "2" },
    ]);
  });

  test("non-array JSON yields empty results", () => {
    expect(parseQmdResults("{}")).toEqual([]);
  });

  test("malformed JSON throws QmdError", () => {
    expect(() => parseQmdResults("not json")).toThrow(QmdError);
  });
});
