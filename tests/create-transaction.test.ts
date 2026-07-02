import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { loadKind } from "../src/artifacts/body";
import { readFrontmatter, serializeArtifact } from "../src/artifacts/artifact-file";
import { captureArtifact } from "../src/artifacts/capture";
import { planCreate } from "../src/artifacts/create-plan";
import { DEFAULT_STRUCTURE } from "../src/artifacts/registry";
import { createArtifact, executeCreate, readArtifact } from "../src/artifacts/store";

// The create transaction (ADR-0045 item 3), tested in-process — planCreate's
// validation-before-dedup ordering and section absorption, and executeCreate's
// write → supersede → backlink → rollback, with no argv and no qmd subprocess.

const tempPaths: string[] = [];
const savedVaultRoot = process.env.KNOWLEDGE_VAULT_ROOT;

afterEach(async () => {
  if (savedVaultRoot === undefined) delete process.env.KNOWLEDGE_VAULT_ROOT;
  else process.env.KNOWLEDGE_VAULT_ROOT = savedVaultRoot;
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFixtureVault(project = "wiki-v2"): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-create-txn-"));
  tempPaths.push(vaultRoot);
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  const projectPath = join(vaultRoot, "projects", project);
  for (const dir of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(projectPath, dir), { recursive: true });
  }
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}

const noOverride = { category: undefined, forceNew: undefined, relatedTo: undefined, supersedes: undefined };

describe("planCreate — validation precedes dedup (NOTE-0010)", () => {
  test("rejects an invalid field with a typed validation error and no plan", async () => {
    // planCreate is pure and has NO dedup dependency: dedup lives in the verb and
    // only runs on a returned plan. A bad field therefore short-circuits to a
    // validation error before any dedup consideration can exist — the ordering is
    // structural, not a runtime check that could be reordered.
    const kind = await loadKind("decision");
    const result = planCreate("decision", kind, DEFAULT_STRUCTURE, {
      project: "wiki-v2",
      fields: { title: "abc", summary: "Use SQLite for the local index." }, // title < min 5
      body: undefined,
      ...noOverride,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    if (result.error.kind !== "validation") throw new Error("unreachable");
    expect(result.error.errors.some((e) => e.field === "title")).toBe(true);
  });

  test("absorbs a machine-owned link-list section into its backing field", async () => {
    const kind = await loadKind("handoff");
    const result = planCreate("handoff", kind, DEFAULT_STRUCTURE, {
      project: "wiki-v2",
      fields: { title: "Session handoff", summary: "A handoff for the session.", phase: "handoff" },
      body: "## Decisions locked\n\n- [[ADR-0001]]\n- [[ADR-0002]]\n",
      ...noOverride,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.absorbed.decisions_made).toEqual(["ADR-0001", "ADR-0002"]);
  });
});

describe("executeCreate — the write transaction", () => {
  test("happy path writes the artifact and backlinks the parent", async () => {
    const vaultRoot = await createFixtureVault();
    const prd = await createArtifact({
      type: "prd",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Parent PRD", summary: "A parent prd summary." },
      structure: DEFAULT_STRUCTURE,
    });

    const kind = await loadKind("slice");
    const planned = planCreate("slice", kind, DEFAULT_STRUCTURE, {
      project: "wiki-v2",
      fields: { title: "Child slice here", summary: "A child slice summary.", parent_prd: prd.id },
      body: undefined,
      ...noOverride,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unreachable");

    const result = await executeCreate(planned.plan, { vaultRoot, structure: DEFAULT_STRUCTURE });
    expect(result.artifact.id).toBe("SLICE-0001");
    expect(result.supersededId).toBeNull();
    expect(await Bun.file(result.artifact.path).exists()).toBe(true);

    const parent = await readArtifact({ type: "prd", vaultRoot, project: "wiki-v2", id: prd.id }, DEFAULT_STRUCTURE);
    expect(parent.fields.slices).toEqual(["SLICE-0001"]);
  });

  test("a post-write failure rolls back: new file removed, superseded target byte-identical", async () => {
    const vaultRoot = await createFixtureVault();

    // A parent PRD that will fail the backlink write: created valid, then corrupted
    // to a schema-stale shape (missing the required `summary`). Reads still succeed
    // (the preflight doesn't validate), but the backlink's setField revalidates and
    // throws — the post-write failure that must trigger rollback.
    const prd = await createArtifact({
      type: "prd",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Parent PRD", summary: "A parent prd summary." },
      structure: DEFAULT_STRUCTURE,
    });
    await writeFile(prd.path, `---\nid: ${prd.id}\ntitle: Parent PRD\nproject: wiki-v2\nstatus: draft\n---\n# Parent PRD\n`);

    // The target the new slice will supersede — snapshot its exact bytes so we can
    // assert the supersede write is rolled back byte-for-byte.
    const oldSlice = await createArtifact({
      type: "slice",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Old slice here", summary: "An old slice summary." },
      structure: DEFAULT_STRUCTURE,
    });
    const snapshot = await readFile(oldSlice.path, "utf8");

    const kind = await loadKind("slice");
    const planned = planCreate("slice", kind, DEFAULT_STRUCTURE, {
      project: "wiki-v2",
      fields: { title: "New slice here", summary: "A new slice summary.", parent_prd: prd.id },
      body: undefined,
      category: undefined,
      forceNew: undefined,
      relatedTo: undefined,
      supersedes: oldSlice.id,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("unreachable");

    await expect(executeCreate(planned.plan, { vaultRoot, structure: DEFAULT_STRUCTURE })).rejects.toThrow();

    // The new slice (SLICE-0002) was removed — only the old slice file survives.
    const slices = (await readdir(join(vaultRoot, "projects", "wiki-v2", "slices"))).filter((f) => f.endsWith(".md"));
    expect(slices).toEqual([basename(oldSlice.path)]);
    // The superseded target was restored to its pre-supersede bytes.
    expect(await readFile(oldSlice.path, "utf8")).toBe(snapshot);
  });
});

describe("capture vs create — equivalent artifacts for identical inputs", () => {
  test("capture files a canonical draft producing the same fields + body as create", async () => {
    // create renders through the template; capture files a draft verbatim. Fed the
    // rendered output as the draft body (identical input), the two paths agree on
    // every field and the body — differing only in the freshly minted id/aliases.
    const vaultRoot = await createFixtureVault();
    const created = await createArtifact({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      fields: {
        title: "Use SQLite",
        summary: "Use SQLite for the local index.",
        context: "Need a durable local index.",
        decision: "Use SQLite for local persistence.",
        consequences: "Keep migrations small and explicit.",
      },
      structure: DEFAULT_STRUCTURE,
    });

    // A draft mirroring create's on-disk artifact, but with an id the vault does not
    // hold (so capture mints a fresh one instead of reporting it already filed).
    const { data, body } = readFrontmatter(await readFile(created.path, "utf8"));
    const dir = await mkdtemp(join(tmpdir(), "wiki-create-txn-src-"));
    tempPaths.push(dir);
    const draft = join(dir, "draft.md");
    await writeFile(draft, serializeArtifact({ ...data, id: "ADR-9999" }, body));

    const outcome = await captureArtifact({ path: draft, cwd: dir });
    expect(outcome?.outcome).toBe("captured");

    const captured = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "ADR-0002" }, DEFAULT_STRUCTURE);
    const createdRead = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: created.id }, DEFAULT_STRUCTURE);

    // Body renders identically (capture wrote create's rendered body verbatim).
    expect(captured.body).toBe(createdRead.body);
    // Fields agree once the minted id/aliases (necessarily fresh per artifact) are dropped.
    const strip = (fields: Record<string, unknown>) => {
      const { id, aliases, ...rest } = fields;
      return rest;
    };
    expect(strip(captured.fields)).toEqual(strip(createdRead.fields));
  });
});
