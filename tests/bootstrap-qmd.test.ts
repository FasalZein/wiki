import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { registerQmdCollections } from "../src/bootstrap/qmd-registration";

const fixturesDir = resolve(import.meta.dir, "fixtures");
const mockQmd = join(fixturesDir, "mock-qmd.sh");

let tempDir: string;
let logFile: string;
const tempPaths: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wiki-qmd-reg-"));
  tempPaths.push(tempDir);
  logFile = join(tempDir, "qmd-log.txt");
  process.env.QMD_LOG_FILE = logFile;
});

afterEach(async () => {
  delete process.env.QMD_LOG_FILE;
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function readLog(): Promise<string[]> {
  const content = await readFile(logFile, "utf8");
  return content.trim().split("\n").filter((line) => line.length > 0);
}

describe("QMD collection registration", () => {
  test("registers project collection via 'collection add'", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipIndexing: true,
      skipResearch: true,
    });

    const lines = await readLog();
    const addLine = lines.find((l) => l.startsWith("collection add"));
    expect(addLine).toBeDefined();
    expect(addLine).toContain("myproject");
    expect(addLine).toContain(projectPath);
    expect(addLine).toContain("**/*.md");
  });

  test("registers context annotations for all 5 subfolders", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipIndexing: true,
      skipResearch: true,
    });

    const lines = await readLog();
    const contextLines = lines.filter((l) => l.startsWith("context add"));

    const subfolders = ["prds", "slices", "adrs", "handovers", "architecture"];
    for (const subfolder of subfolders) {
      const match = contextLines.find((l) => l.includes(`qmd://myproject/${subfolder}`));
      expect(match).toBeDefined();
    }
  });

  test("registers root context with project description", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    await registerQmdCollections(mockQmd, "myproject", projectPath, "My awesome project description", {
      skipIndexing: true,
      skipResearch: true,
    });

    const lines = await readLog();
    const contextLines = lines.filter((l) => l.startsWith("context add"));
    const rootContext = contextLines.find((l) => l.includes("qmd://myproject ") || l.includes("qmd://myproject\t"));

    // Root context line should exist and contain the project description
    // The root context uses qmd://collection (no subfolder)
    expect(rootContext).toBeDefined();
    expect(rootContext).toContain("My awesome project description");
  });

  test("context annotation format uses qmd://collection/subfolder syntax", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipIndexing: true,
      skipResearch: true,
    });

    const lines = await readLog();
    const contextLines = lines.filter((l) => l.startsWith("context add"));

    // Every subfolder context line should use qmd:// protocol
    const subfolderContexts = contextLines.filter((l) => l.includes("qmd://myproject/"));
    expect(subfolderContexts).toHaveLength(5);

    for (const line of subfolderContexts) {
      expect(line).toMatch(/qmd:\/\/myproject\/\w+/);
    }
  });

  test("registers research source collections for paths that exist", async () => {
    // Create a fake research directory that one of the sources would resolve to
    const fakeResearchDir = join(tempDir, "research-test");
    await mkdir(fakeResearchDir, { recursive: true });

    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    // We override HOME so that ~ expansion resolves to tempDir-based paths
    const originalHome = process.env.HOME;
    // Create the directory structure that matches one research source: ~/.pi/artifacts/research
    const piResearch = join(tempDir, ".pi", "artifacts", "research");
    await mkdir(piResearch, { recursive: true });
    process.env.HOME = tempDir;

    try {
      await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
        skipIndexing: true,
      });

      const lines = await readLog();
      // Should have a collection add for the research source
      const researchAdd = lines.find((l) => l.startsWith("collection add") && l.includes("research-pi"));
      expect(researchAdd).toBeDefined();
      expect(researchAdd).toContain(piResearch);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("skips research source collections for paths that do not exist", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    // Set HOME to a temp dir where no research dirs exist
    const originalHome = process.env.HOME;
    const emptyHome = join(tempDir, "empty-home");
    await mkdir(emptyHome, { recursive: true });
    process.env.HOME = emptyHome;

    try {
      await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
        skipIndexing: true,
      });

      const lines = await readLog();
      // No research collection should be registered
      const researchAdds = lines.filter((l) => l.startsWith("collection add") && l.includes("research-"));
      expect(researchAdds).toHaveLength(0);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("initial indexing calls update + embed for the project collection", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipResearch: true,
    });

    const lines = await readLog();
    const updateLine = lines.find((l) => l.startsWith("update") && l.includes("-c") && l.includes("myproject"));
    const embedLine = lines.find((l) => l.startsWith("embed") && l.includes("-c") && l.includes("myproject"));

    expect(updateLine).toBeDefined();
    expect(embedLine).toBeDefined();
  });

  test("skipIndexing: true skips update + embed calls", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipIndexing: true,
      skipResearch: true,
    });

    const lines = await readLog();
    const updateLines = lines.filter((l) => l.startsWith("update"));
    const embedLines = lines.filter((l) => l.startsWith("embed"));

    expect(updateLines).toHaveLength(0);
    expect(embedLines).toHaveLength(0);
  });

  test("result reports collections registered and context count", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    const result = await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipIndexing: true,
      skipResearch: true,
    });

    expect(result.collectionsRegistered).toContain("myproject");
    // 5 subfolders + 1 root = 6 context annotations
    expect(result.contextsRegistered).toBe(6);
    expect(result.indexed).toBe(false);
  });

  test("result reports indexed: true when indexing runs", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    const result = await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
      skipResearch: true,
    });

    expect(result.indexed).toBe(true);
  });

  test("research source collections appear in result when registered", async () => {
    const projectPath = join(tempDir, "myproject");
    await mkdir(projectPath, { recursive: true });

    const originalHome = process.env.HOME;
    const piResearch = join(tempDir, ".pi", "artifacts", "research");
    await mkdir(piResearch, { recursive: true });
    process.env.HOME = tempDir;

    try {
      const result = await registerQmdCollections(mockQmd, "myproject", projectPath, "A test project", {
        skipIndexing: true,
      });

      expect(result.collectionsRegistered).toContain("research-pi");
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
