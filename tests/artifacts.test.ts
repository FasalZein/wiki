import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendField, ArtifactValidationError, createArtifact, readArtifact, setField } from "../src/artifacts/store";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("artifact store", () => {
  test("creates DECISION-0001 in an empty decisions folder", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const artifact = await createArtifact({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      fields: decisionFields(),
    });

    expect(artifact.id).toBe("DECISION-0001");
    expect(artifact.path).toBe(join(vaultRoot, "projects", "wiki-v2", "decisions", "DECISION-0001.md"));

    const file = await readFile(artifact.path, "utf8");
    expect(file).toContain("id: DECISION-0001");
    expect(file).toContain("title: Use SQLite");
    expect(file).toContain("project: wiki-v2");
    expect(file).toContain("status: accepted");
    expect(file).toContain("# Use SQLite");
    expect(file).toContain("Use SQLite for local persistence.");
  });

  test("creates the next unused decision id when files already exist", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    const decisionsPath = join(vaultRoot, "projects", "wiki-v2", "decisions");
    await writeFile(join(decisionsPath, "DECISION-0001.md"), "existing");
    await writeFile(join(decisionsPath, "DECISION-0003.md"), "existing");

    const artifact = await createArtifact({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      fields: decisionFields(),
    });

    expect(artifact.id).toBe("DECISION-0002");
  });

  test("reads a decision artifact with frontmatter fields and rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });

    const artifact = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "DECISION-0001" });

    expect(artifact.fields.title).toBe("Use SQLite");
    expect(artifact.body).toContain("# Use SQLite");
    expect(artifact.body).toContain("## Decision\n\nUse SQLite for local persistence.");
  });

  test("sets one frontmatter field and preserves the rendered body", async () => {
    const vaultRoot = await createFixtureVault("wiki-v2");
    await createArtifact({ type: "decision", vaultRoot, project: "wiki-v2", fields: decisionFields() });
    const before = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "DECISION-0001" });

    const after = await setField({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      id: "DECISION-0001",
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
    const before = await readArtifact({ type: "decision", vaultRoot, project: "wiki-v2", id: "DECISION-0001" });

    const after = await appendField({
      type: "decision",
      vaultRoot,
      project: "wiki-v2",
      id: "DECISION-0001",
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
        id: "DECISION-0001",
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
  const projectPath = join(vaultRoot, "projects", project);
  await mkdir(join(projectPath, "prds"), { recursive: true });
  await mkdir(join(projectPath, "slices"));
  await mkdir(join(projectPath, "decisions"));
  await mkdir(join(projectPath, "handovers"));
  await writeFile(join(projectPath, "_project.md"), `# ${project}\n`);
  return vaultRoot;
}
