import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SKILL_TO_KIND } from "../src/artifacts/registry";

const repoRoot = import.meta.dir.replace(/\/tests$/, "");

/** The authoritative authoring-skill list, derived from the wiki.json map. The
 *  README block is generated from exactly this, so the two can never drift. */
function expectedSkillMapBlock(): string {
  return Object.entries(SKILL_TO_KIND)
    .map(([skill, kind]) => `- \`${skill}\` → authors \`${kind}\``)
    .join("\n");
}

/** Pull the content between the skill-map markers out of the README. */
function readmeSkillMapBlock(readme: string): string {
  const begin = "<!-- skill-map:begin (generated from wiki.json — keep in sync) -->";
  const end = "<!-- skill-map:end -->";
  const start = readme.indexOf(begin);
  const stop = readme.indexOf(end);
  if (start === -1 || stop === -1) throw new Error("README is missing the skill-map markers");
  return readme.slice(start + begin.length, stop).trim();
}

describe("README skill list reconciles with the wiki.json skill map", () => {
  test("the README skill-map block equals the wiki.json skill map", async () => {
    const readme = await readFile(join(repoRoot, "README.md"), "utf8");
    expect(readmeSkillMapBlock(readme)).toBe(expectedSkillMapBlock());
  });

  test("the vendored bundle ships only the wiki router, which is not an authoring skill", async () => {
    const entries = await readdir(join(repoRoot, "skills"), { withFileTypes: true });
    const vendored = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    // The bundle and the map are disjoint by design: the bundle vendors the
    // `wiki` router; the authoring skills in the map live in the user's own
    // skill collection, not here.
    expect(vendored).toEqual(["wiki"]);
    expect(Object.keys(SKILL_TO_KIND)).not.toContain("wiki");
  });
});
