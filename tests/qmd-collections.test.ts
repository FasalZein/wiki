import { describe, expect, test } from "bun:test";

import { parseCollectionNames } from "../src/integrations/qmd";

// Sample shaped like real `qmd collection list` output.
const LIST_OUTPUT = `Collections (3):

bayland-portfolio-v1 (qmd://bayland-portfolio-v1/)
  Pattern:  **/*.md
  Files:    1044
  Updated:  28m ago

bayland-platform (qmd://bayland-platform/)
  Pattern:  **/*.md
  Files:    17
  Updated:  28m ago

rift (qmd://rift/)
  Pattern:  **/*.md
  Files:    39
  Updated:  28m ago
`;

describe("parseCollectionNames", () => {
  test("extracts exact collection names", () => {
    expect(parseCollectionNames(LIST_OUTPUT)).toEqual([
      "bayland-portfolio-v1",
      "bayland-platform",
      "rift",
    ]);
  });

  // Regression: a string .includes() check reported "bayland" as present because
  // it is a substring of "bayland-portfolio-v1", so ensureCollection skipped the
  // add and `update -c bayland` failed with "Collection not found".
  test("a name that is a substring of another collection is not a member", () => {
    const names = parseCollectionNames(LIST_OUTPUT);
    expect(names.includes("bayland")).toBe(false);
    expect(names.includes("bayland-platform")).toBe(true);
  });

  test("returns empty for output with no collections", () => {
    expect(parseCollectionNames("Collections (0):\n")).toEqual([]);
  });
});
