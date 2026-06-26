import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactTypeForVaultPath } from "../src/artifacts/registry";
import { exists, expandHome, isFileNotFound, isRecord } from "../src/util";

// SLICE-0099: the consolidated util module and the single path-convention helper.
describe("util consolidation (SLICE-0099)", () => {
  test("isFileNotFound matches ENOENT errors only", () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    const eexist = Object.assign(new Error("there"), { code: "EEXIST" });
    expect(isFileNotFound(enoent)).toBe(true);
    expect(isFileNotFound(eexist)).toBe(false);
    expect(isFileNotFound(new Error("plain"))).toBe(false);
    expect(isFileNotFound("string")).toBe(false);
  });

  test("isRecord excludes null and arrays", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  test("expandHome expands ~ and ~/ via the OS home and passes others through", () => {
    const home = process.env.HOME!;
    expect(expandHome("~")).toBe(home);
    expect(expandHome("~/Knowledge")).toBe(`${home}/Knowledge`);
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative")).toBe("relative");
  });

  test("exists reflects whether a path is accessible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiki-util-"));
    expect(await exists(dir)).toBe(true);
    expect(await exists(join(dir, "missing.txt"))).toBe(false);
  });
});

describe("artifactTypeForVaultPath (SLICE-0099)", () => {
  test("maps a folder segment under projects/<name>/ to its type", () => {
    expect(artifactTypeForVaultPath("projects/wiki-v2/prds/PRD-0001-x.md")).toBe("prd");
    expect(artifactTypeForVaultPath("projects/wiki-v2/slices/SLICE-0001-x.md")).toBe("slice");
  });

  test("returns undefined outside the projects/<name>/<folder>/ layout", () => {
    expect(artifactTypeForVaultPath("prds/PRD-0001-x.md")).toBeUndefined();
    expect(artifactTypeForVaultPath("projects/wiki-v2/prds")).toBeUndefined();
    expect(artifactTypeForVaultPath("notprojects/wiki-v2/prds/x.md")).toBeUndefined();
    expect(artifactTypeForVaultPath("projects/wiki-v2/unknownfolder/x.md")).toBeUndefined();
  });
});
