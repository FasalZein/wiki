import { describe, expect, test } from "bun:test";
import { ParseError, parseCommand } from "../src/cli/parse";

describe("parseCommand dash-leading values (SLICE-0086)", () => {
  test("a value beginning with a dash throws an actionable ParseError, not a node-internals error", () => {
    expect(() => parseCommand(["--title", "-foo"], ["title"])).toThrow(ParseError);
    try {
      parseCommand(["--title", "-foo"], ["title"]);
    } catch (error) {
      const message = (error as Error).message;
      // names the fix: the --flag=value form and the -- escape
      expect(message).toContain("--title=");
      expect(message).toContain("--");
      // not the raw node internals wording
      expect(message).not.toContain("ERR_PARSE_ARGS");
    }
  });

  test("a dash-leading value passed with --flag=value parses cleanly", () => {
    const parsed = parseCommand(["--title=-dash first"], ["title"]);
    expect(parsed.values.title).toBe("-dash first");
  });

  test("a normal value still parses", () => {
    const parsed = parseCommand(["--title", "normal"], ["title"]);
    expect(parsed.values.title).toBe("normal");
  });
});
