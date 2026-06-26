import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("links verb (graph read)", () => {
  test("wiki links <id> prints outbound (frontmatter + body) and inbound backlinks", async () => {
    const f = await fixture();
    // target slice: outbound link in frontmatter (blocked_by) + a body wikilink
    await writeSlice(f, "SLICE-0001", {
      title: "Target slice",
      blocked_by: ["[[SLICE-0002]]"],
      body: "Builds on [[PRD-0001]] and ignores [[JIRA-9]] (cross-prefix).",
    });
    await writeSlice(f, "SLICE-0002", { title: "An out target" });
    await writePrd(f, "PRD-0001", { title: "Parent PRD" });
    // an inbound backlink: SLICE-0003's frontmatter references the target
    await writeSlice(f, "SLICE-0003", { title: "References target", blocked_by: ["[[SLICE-0001]]"] });

    const result = await runWiki(["links", "SLICE-0001", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.id).toBe("SLICE-0001");
    expect(out.outbound.sort()).toEqual(["PRD-0001", "SLICE-0002"]);
    expect(out.inbound).toEqual(["SLICE-0003"]);
  });

  test("wiki links <id> human output lists both directions and never calls qmd", async () => {
    const f = await fixture();
    await writeSlice(f, "SLICE-0001", { title: "Lonely", body: "no links here" });

    const result = await runWiki(["links", "SLICE-0001", "--project", "wiki-v2"], f);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("outbound");
    expect(result.stdout).toContain("inbound");
    expect(result.stdout).toContain("(none)");
    // pure vault read: the fake qmd never recorded a call
    expect(f.qmdCalled()).toBe(false);
  });

  test("wiki links <id> fails cleanly when the id has no artifact", async () => {
    const f = await fixture();

    const result = await runWiki(["links", "SLICE-9999", "--project", "wiki-v2", "--json"], f);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toContain("not found");
  });
});

type Fixture = {
  vaultRoot: string;
  projectPath: string;
  env: Record<string, string>;
  qmdCalled: () => boolean;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wiki-links-"));
  tempPaths.push(root);
  const vaultRoot = join(root, "vault");
  const projectPath = join(vaultRoot, "projects", "wiki-v2");
  for (const dir of ["prds", "slices", "adrs", "handoffs", "docs"]) {
    await mkdir(join(projectPath, dir), { recursive: true });
  }
  await writeFile(join(projectPath, "_project.md"), `---\nrepo: /tmp/repo\ntest_command: bun test\n---\n# wiki-v2\n`);

  const callLog = join(root, "qmd-called.log");
  const qmdCommand = join(root, "fake-qmd");
  await writeFile(qmdCommand, `#!/usr/bin/env bash\necho called >> "${callLog}"\n`, { mode: 0o755 });

  return {
    vaultRoot,
    projectPath,
    env: { QMD_COMMAND: qmdCommand },
    qmdCalled: () => existsSync(callLog),
  };
}

async function writeSlice(
  f: Fixture,
  id: string,
  opts: { title: string; blocked_by?: string[]; body?: string },
): Promise<void> {
  const fm = [`id: ${id}`, `title: ${opts.title}`, "summary: A slice.", "status: planned"];
  if (opts.blocked_by !== undefined) fm.push("blocked_by:", ...opts.blocked_by.map((b) => `  - '${b}'`));
  await writeFile(
    join(f.projectPath, "slices", `${id}.md`),
    `---\n${fm.join("\n")}\n---\n${opts.body ?? "body"}\n`,
  );
}

async function writePrd(f: Fixture, id: string, opts: { title: string }): Promise<void> {
  await writeFile(
    join(f.projectPath, "prds", `${id}.md`),
    `---\nid: ${id}\ntitle: ${opts.title}\nsummary: A PRD.\nstatus: draft\n---\nbody\n`,
  );
}

async function runWiki(args: string[], f: Fixture): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir.replace(/\/tests$/, ""),
    env: { ...process.env, KNOWLEDGE_VAULT_ROOT: f.vaultRoot, ...f.env },
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
