import { describe, expect, test } from "bun:test";

import { parseCollectionNames, QmdError } from "../src/integrations/qmd";

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

  // Hardening (SLICE-0124): names are read from the stable `qmd://<name>/` URI,
  // not the leading human-readable column. A qmd version that reformats the
  // list line (extra indent, a bullet prefix, different spacing) must still
  // parse, or an existing collection would masquerade as 'never synced'.
  test("parses names from the qmd:// URI even when the line format changes", () => {
    const reformatted = [
      "Collections (2):",
      "",
      "  - bayland-portfolio-v1   (qmd://bayland-portfolio-v1/)  [1044 files]",
      "\t* rift -> qmd://rift/ (39 files, updated 28m ago)",
      "",
    ].join("\n");
    expect(parseCollectionNames(reformatted)).toEqual(["bayland-portfolio-v1", "rift"]);
  });
});

describe("QmdError.summary", () => {
  // Regression: qmd surfaces a native-module/dlopen failure as a ~25-line Node stack
  // trace. sync printed the full message; it must show one meaningful line instead.
  test("extracts the Error: line from a multi-line stack trace", () => {
    const stack = [
      "node:internal/modules/cjs/loader:1996",
      "  return process.dlopen(module, path.toNamespacedPath(filename));",
      "Error: The module 'better_sqlite3.node' was compiled against a different Node version",
      "    at Module._extensions..node (node:internal/modules/cjs/loader:1996:18)",
    ].join("\n");
    expect(new QmdError(stack).summary).toBe(
      "Error: The module 'better_sqlite3.node' was compiled against a different Node version",
    );
  });

  test("falls back to the first non-empty line when no Error: line exists", () => {
    expect(new QmdError("\nqmd exited 1\n").summary).toBe("qmd exited 1");
  });
});
