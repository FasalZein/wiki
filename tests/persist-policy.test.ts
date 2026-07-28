import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStructure, loadStructure, persistPolicyOf } from "../src/artifacts/registry";
import { hookGuidance } from "../src/cli/verbs/hooks";

// ADR-0048: a bound authoring skill used to produce TWO prompts to file its
// output — guidance when the skill started, then a debt reminder on the next
// user prompt if nothing was captured. That is a durability judgment the hook
// makes before it has seen the output. Each kind now declares how hard it wants
// to be chased, and the default (`suggest`) says it once.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tmpCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wiki-persist-policy-"));
  tempPaths.push(dir);
  return dir;
}

describe("ADR-0048 persist policy", () => {
  test("defaults to 'suggest' when a kind declares nothing", () => {
    expect(persistPolicyOf({})).toBe("suggest");
    expect(persistPolicyOf({ persist: "remind" })).toBe("remind");
    expect(persistPolicyOf({ persist: "never" })).toBe("never");
  });

  test("a 'never' kind injects no guidance at all", async () => {
    const structure = buildStructure({
      research: { prefix: "RES", folder: "research", dedup: true, skill: "research", persist: "never" },
    });

    expect(await hookGuidance("research", await tmpCwd(), structure)).toBeNull();
  });

  test("a 'suggest' kind injects guidance once", async () => {
    const structure = buildStructure({
      research: { prefix: "RES", folder: "research", dedup: true, skill: "research", persist: "suggest" },
    });

    const text = await hookGuidance("research", await tmpCwd(), structure);

    expect(text).not.toBeNull();
    expect(text).toContain("wiki create research");
  });

  test("an undeclared kind still injects guidance — the default is suggest, not silence", async () => {
    const structure = buildStructure({
      prd: { prefix: "PRD", folder: "prds", dedup: true, skill: "to-prd" },
    });

    expect(await hookGuidance("to-prd", await tmpCwd(), structure)).not.toBeNull();
  });

  test("an unknown skill injects nothing regardless of policy", async () => {
    const structure = buildStructure({
      prd: { prefix: "PRD", folder: "prds", dedup: true, skill: "to-prd", persist: "remind" },
    });

    expect(await hookGuidance("not-a-bound-skill", await tmpCwd(), structure)).toBeNull();
  });

  test("an invalid policy in a vault's wiki.json fails at load, naming the valid values", async () => {
    const vault = await tmpCwd();
    await mkdir(join(vault, "projects"), { recursive: true });
    await writeFile(
      join(vault, "wiki.json"),
      JSON.stringify({ kinds: { prd: { prefix: "PRD", folder: "prds", dedup: true, persist: "nag" } } }),
    );

    await expect(loadStructure(vault)).rejects.toThrow(/persist.*never \| suggest \| remind/);
  });

  test("the bundled research kind ships persist: never and stays bound to its skill", async () => {
    // The binding survives (capture still routes research drafts to the right
    // kind); only the chasing stops.
    const bundled = JSON.parse(await readFile(join(import.meta.dir, "..", "wiki.json"), "utf8"));

    expect(bundled.kinds.research.persist).toBe("never");
    expect(bundled.kinds.research.skill).toBe("research");
  });
});
