import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ADR-0047 field-role neutrality", () => {
  test("renamed roles drive block, supersede, and terminal-status fmt through the CLI", async () => {
    const f = await fixture({
      roles: {
        supersede_link: "replaced_by",
        status: "state",
        superseded_status: "replaced",
        depends_on: "requires",
        terminal_status: "done",
      },
    });
    await seed(f, "WORK-0001", "Old work", "active");
    await seed(f, "WORK-0002", "New work", "done");

    const blocked = await runWiki(["block", "WORK-0001", "--on", "WORK-0099", "--project", "p", "--json"], f);
    expect(blocked.exitCode).toBe(0);
    expect(JSON.parse(blocked.stdout).requires).toEqual(["[[WORK-0099]]"]);

    const superseded = await runWiki(["supersede", "WORK-0001", "--by", "WORK-0002", "--project", "p", "--json"], f);
    expect(superseded.exitCode).toBe(0);
    const old = await readFile(artifactPath(f, "WORK-0001", "old-work"), "utf8");
    expect(old).toContain("state: replaced");
    expect(old).toContain("replaced_by: WORK-0002");
    expect(old).toContain("requires:");

    const formatted = await runWiki(["fmt", "--project", "p", "--write"], f);
    expect(formatted.exitCode).toBe(0);
    expect(await readFile(artifactPath(f, "WORK-0002", "new-work"), "utf8")).toContain("- [x] Verify work");
  });

  test("a wiki.json with no roles key keeps the legacy field and status literals", async () => {
    const f = await fixture({});
    await seed(f, "WORK-0001", "Old work", "active", true);
    await seed(f, "WORK-0002", "New work", "closed", true);

    expect((await runWiki(["block", "WORK-0001", "--on", "WORK-0099", "--project", "p"], f)).exitCode).toBe(0);
    expect((await runWiki(["supersede", "WORK-0001", "--by", "WORK-0002", "--project", "p"], f)).exitCode).toBe(0);
    expect((await runWiki(["fmt", "--project", "p", "--write"], f)).exitCode).toBe(0);

    const old = await readFile(artifactPath(f, "WORK-0001", "old-work"), "utf8");
    expect(old).toContain("status: superseded");
    expect(old).toContain("superseded_by: WORK-0002");
    expect(old).toContain("blocked_by:");
    expect(await readFile(artifactPath(f, "WORK-0002", "new-work"), "utf8")).toContain("- [x] Verify work");
  });

  test("wiki block reports unsupported kinds before schema validation and names wiki set", async () => {
    const f = await fixture({}, false);
    await seed(f, "WORK-0001", "Plain work", "active", true, false);

    const result = await runWiki(["block", "WORK-0001", "--on", "WORK-0099", "--project", "p"], f);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("wiki block is unsupported for kind work");
    expect(result.stderr).toContain("wiki set");
    expect(result.stderr).not.toContain("unknown field");
  });
});

type Fixture = { vaultRoot: string; projectPath: string; env: Record<string, string> };
type Roles = {
  roles?: {
    supersede_link: string;
    status: string;
    superseded_status: string;
    depends_on: string;
    terminal_status: string;
  };
};

async function fixture(config: Roles, includeDepends = true): Promise<Fixture> {
  const vaultRoot = await mkdtemp(join(tmpdir(), "wiki-roles-"));
  tempPaths.push(vaultRoot);
  const projectPath = join(vaultRoot, "projects", "p");
  await mkdir(join(projectPath, "work"), { recursive: true });
  await mkdir(join(vaultRoot, "templates"), { recursive: true });
  await writeFile(join(projectPath, "_project.md"), "---\nproject: p\n---\n# p\n");
  await writeFile(join(vaultRoot, "wiki.json"), JSON.stringify({
    kinds: { work: { prefix: "WORK", folder: "work", dedup: false, ...config } },
  }));
  await writeFile(join(vaultRoot, "templates", "work.md"), template(config.roles !== undefined, includeDepends));
  return { vaultRoot, projectPath, env: { KNOWLEDGE_VAULT_ROOT: vaultRoot } };
}

function template(renamed: boolean, includeDepends: boolean): string {
  const status = renamed ? "state" : "status";
  const link = renamed ? "replaced_by" : "superseded_by";
  const depends = renamed ? "requires" : "blocked_by";
  const statuses = renamed ? "[active, done, replaced]" : "[active, closed, superseded]";
  return `---
template: work
version: 1
schema:
  id: { type: string, required: true }
  aliases: { type: list, default: [] }
  title: { type: string, required: true }
  project: { type: string, required: true }
  ${status}: { type: enum, required: true, values: ${statuses} }
${includeDepends ? `  ${depends}: { type: link_list, default: [] }\n` : ""}  ${link}: { type: link }
  created: { type: date, auto: true }
  updated: { type: date, auto: true }
---
# {{title}}

## Todo

- [ ] Verify work
`;
}

async function seed(
  f: Fixture,
  id: string,
  title: string,
  status: string,
  legacy = false,
  includeDepends = true,
): Promise<void> {
  const statusField = legacy ? "status" : "state";
  const dependsField = legacy ? "blocked_by" : "requires";
  await writeFile(
    artifactPath(f, id, title.toLowerCase().replace(/ /g, "-")),
    `---\nid: ${id}\naliases: [${id}]\ntitle: ${title}\nproject: p\n${statusField}: ${status}\n${includeDepends ? `${dependsField}: []\n` : ""}created: '2026-01-01'\nupdated: '2026-01-01'\n---\n# ${title}\n\n## Todo\n\n- [ ] Verify work\n`,
  );
}

function artifactPath(f: Fixture, id: string, slug: string): string {
  return join(f.projectPath, "work", `${id}-${slug}.md`);
}

async function runWiki(args: string[], f: Fixture): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, ...f.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
