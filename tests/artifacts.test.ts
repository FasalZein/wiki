import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendField, ArtifactValidationError, createArtifact, readArtifact, setField } from "../src/artifacts/store";

const MOCK_BIN = join(import.meta.dir, "fixtures", "mock-obsidian.sh");

beforeAll(() => {
  process.env.OBSIDIAN_BIN = MOCK_BIN;
});

afterAll(() => {
  delete process.env.OBSIDIAN_BIN;
});

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("artifact store", () => {
  test("creates ADR-0001 with a human-readable filename in an empty adrs folder", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const artifact = await createArtifact({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      fields: decisionFields(),
    });

    expect(artifact.id).toBe("ADR-0001");
    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "adrs", "ADR-0001-use-sqlite.md"));

    const file = await readFile(artifact.path, "utf8");
    expect(file).toContain("id: ADR-0001");
    expect(file).toContain("title: Use SQLite");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("status: accepted");
    expect(file).toContain("# Use SQLite");
    expect(file).toContain("Use SQLite for local persistence.");
  });

  test("creates the next decision id after the highest existing old or human-readable number", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const adrsPath = join(vaultRoot, "projects", "wiki-v2", "adrs");
    await writeFile(join(adrsPath, "ADR-0001.md"), "existing");
    await writeFile(join(adrsPath, "ADR-0003-use-sqlite.md"), "existing");

    const artifact = await createArtifact({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      fields: decisionFields(),
    });

    expect(artifact.id).toBe("ADR-0004");
  });

  test("creates PRD-0001 with a human-readable filename in an empty prds folder", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const artifact = await createArtifact({
      type: "prd",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Core wiki CLI" },
    });

    expect(artifact.id).toBe("PRD-0001");
    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "prds", "PRD-0001-core-wiki-cli.md"));

    const file = await readFile(artifact.path, "utf8");
    expect(file).toContain("id: PRD-0001");
    expect(file).toContain("title: Core wiki CLI");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("status: draft");
  });

  test("stamps the bare id as an alias so [[PRD-0001]] links resolve", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const artifact = await createArtifact({
      type: "prd",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Core wiki CLI" },
    });

    expect(artifact.fields.aliases).toEqual(["PRD-0001"]);
    const file = await readFile(artifact.path, "utf8");
    expect(file).toContain("aliases:");
    expect(file).toContain("- PRD-0001");
  });

  test("reads human-readable artifact filenames by id", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({
      type: "prd",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Core wiki CLI" },
    });

    const artifact = await readArtifact({ type: "prd", vaultRoot, project: "wiki-v2", id: "PRD-0001" });

    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "prds", "PRD-0001-core-wiki-cli.md"));
    expect(artifact.fields.title).toBe("Core wiki CLI");
  });

  test("creates a doc inside its category subfolder", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const artifact = await createArtifact({
      type: "doc",
      vaultRoot,
      project: "wiki-v2",
      category: "research",
      fields: { title: "Native search benchmark", type: "research" },
    });

    expect(artifact.id).toBe("DOC-0001");
    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "docs", "research", "DOC-0001-native-search-benchmark.md"));
  });

  test("reads a doc by id from its category subfolder", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({
      type: "doc",
      vaultRoot,
      project: "wiki-v2",
      category: "runbooks",
      fields: { title: "Deploy runbook", type: "runbook" },
    });

    const artifact = await readArtifact({ type: "doc", vaultRoot, project: "wiki-v2", id: "DOC-0001" });
    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "docs", "runbooks", "DOC-0001-deploy-runbook.md"));
    expect(artifact.fields.title).toBe("Deploy runbook");
  });

  test("creates SLICE-0001 with a human-readable filename in an empty slices folder", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const artifact = await createArtifact({
      type: "slice",
      vaultRoot,
      project: "wiki-v2",
      fields: { title: "Build slice authoring", parent_prd: "PRD-0001", acceptance: [] },
    });

    expect(artifact.id).toBe("SLICE-0001");
    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "slices", "SLICE-0001-build-slice-authoring.md"));

    const file = await readFile(artifact.path, "utf8");
    expect(file).toContain("id: SLICE-0001");
    expect(file).toContain("title: Build slice authoring");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("status: planned");
    expect(file).toContain("type: AFK");
    expect(file).toContain("parent_prd: PRD-0001");
  });

  test("reads a decision artifact with frontmatter fields and rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });

    const artifact = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "ADR-0001" });

    expect(artifact.fields.title).toBe("Use SQLite");
    expect(artifact.body).toContain("# Use SQLite");
    expect(artifact.body).toContain("## Decision\n\nUse SQLite for local persistence.");
  });

  test("sets one frontmatter field and preserves the rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });
    const before = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "ADR-0001" });

    const after = await setField({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      id: "ADR-0001",
      field: "status",
      value: "proposed",
    });

    expect(after.fields.status).toBe("proposed");
    expect(after.body).toBe(before.body);
    expect(await readFile(after.path, "utf8")).toContain("status: proposed");
  });

  test("appends to a list frontmatter field in order and preserves the body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });
    const before = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "ADR-0001" });

    const after = await appendField({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      id: "ADR-0001",
      field: "context_terms",
      value: "Vault",
    });

    expect(after.fields.context_terms).toEqual(["Vault"]);
    expect(after.body).toBe(before.body);
  });

  test("rejects setting a field not declared by the template schema", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });

    await expect(
      setField({
        type: "decision",
        vaultRoot,
        project: "wiki-v2",
        id: "ADR-0001",
        field: "unknown",
        value: "value",
      }),
    ).rejects.toThrow(ArtifactValidationError);
  });
});

function decisionFields(): Record<string, unknown> {
  return {
    title: "Use SQLite",
    context: "Need a durable local index.",
    decision: "Use SQLite for local persistence.",
    consequences: "Keep migrations small and explicit.",
  };
}

async function createFixtureVault(project: string): Promise<string> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-vault-"));
  tempPaths.push(vaultRoot);
  process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "adrs"));
  await mkdir(join(projectPath, "handovers"));
  await mkdir(join(projectPath, "docs"));
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}
