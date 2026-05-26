import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectSkillsDir, installSkillSymlink } from "../src/bootstrap/skill-symlink";

let tempPaths: string[] = [];
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(tempPaths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function makeTempDir(prefix = "wiki-skill-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

describe("detectSkillsDir", () => {
  test("returns null when no conventional dir exists", async () => {
    const fakeHome = await makeTempDir();
    process.env.HOME = fakeHome;

    const result = detectSkillsDir();
    expect(result).toBeNull();
  });

  test("returns the first existing conventional path", async () => {
    const fakeHome = await makeTempDir();
    process.env.HOME = fakeHome;

    // Create the second conventional path (.pi/agent/skills) but NOT the first (.claude/skills)
    const piSkills = join(fakeHome, ".pi", "agent", "skills");
    await mkdir(piSkills, { recursive: true });

    const result = detectSkillsDir();
    expect(result).toBe(piSkills);
  });

  test("returns .claude/skills when it exists (first in priority)", async () => {
    const fakeHome = await makeTempDir();
    process.env.HOME = fakeHome;

    // Create both first and second conventional paths
    const claudeSkills = join(fakeHome, ".claude", "skills");
    const piSkills = join(fakeHome, ".pi", "agent", "skills");
    await mkdir(claudeSkills, { recursive: true });
    await mkdir(piSkills, { recursive: true });

    const result = detectSkillsDir();
    expect(result).toBe(claudeSkills);
  });
});

describe("installSkillSymlink", () => {
  test("symlink created successfully when skills dir exists", async () => {
    const fakeHome = await makeTempDir();
    const skillsDir = join(fakeHome, ".claude", "skills");
    await mkdir(skillsDir, { recursive: true });

    // Create a fake repo skills/wiki dir
    const repoSkillsDir = await makeTempDir("wiki-repo-skills-");
    const repoWiki = join(repoSkillsDir, "wiki");
    await mkdir(repoWiki, { recursive: true });

    const result = await installSkillSymlink(repoSkillsDir, skillsDir);

    expect(result.status).toBe("created");
    expect(result.target).toBeDefined();
    expect(result.link).toBeDefined();
  });

  test("symlink target points to correct source", async () => {
    const fakeHome = await makeTempDir();
    const skillsDir = join(fakeHome, ".claude", "skills");
    await mkdir(skillsDir, { recursive: true });

    const repoSkillsDir = await makeTempDir("wiki-repo-skills-");
    const repoWiki = join(repoSkillsDir, "wiki");
    await mkdir(repoWiki, { recursive: true });

    await installSkillSymlink(repoSkillsDir, skillsDir);

    const linkPath = join(skillsDir, "wiki");
    const target = await readlink(linkPath);
    expect(target).toBe(repoWiki);
  });

  test("existing correct symlink is skipped (status: exists)", async () => {
    const fakeHome = await makeTempDir();
    const skillsDir = join(fakeHome, ".claude", "skills");
    await mkdir(skillsDir, { recursive: true });

    const repoSkillsDir = await makeTempDir("wiki-repo-skills-");
    const repoWiki = join(repoSkillsDir, "wiki");
    await mkdir(repoWiki, { recursive: true });

    // Create the symlink first
    await symlink(repoWiki, join(skillsDir, "wiki"));

    const result = await installSkillSymlink(repoSkillsDir, skillsDir);

    expect(result.status).toBe("exists");
  });

  test("existing symlink to wrong target returns exists with warning message", async () => {
    const fakeHome = await makeTempDir();
    const skillsDir = join(fakeHome, ".claude", "skills");
    await mkdir(skillsDir, { recursive: true });

    // Create a symlink pointing to a different location
    const wrongTarget = await makeTempDir("wiki-wrong-target-");
    const wrongWiki = join(wrongTarget, "wiki");
    await mkdir(wrongWiki, { recursive: true });
    await symlink(wrongWiki, join(skillsDir, "wiki"));

    // Now try to install with the correct repo
    const repoSkillsDir = await makeTempDir("wiki-repo-skills-");
    const repoWiki = join(repoSkillsDir, "wiki");
    await mkdir(repoWiki, { recursive: true });

    const result = await installSkillSymlink(repoSkillsDir, skillsDir);

    expect(result.status).toBe("exists");
    expect(result.message).toBeDefined();
    expect(result.message).toContain(wrongWiki);
    expect(result.message).toContain(repoWiki);
  });

  test("missing skills dir returns status not-found with manual instructions", async () => {
    const fakeHome = await makeTempDir();
    process.env.HOME = fakeHome;

    const repoSkillsDir = await makeTempDir("wiki-repo-skills-");
    const repoWiki = join(repoSkillsDir, "wiki");
    await mkdir(repoWiki, { recursive: true });

    // Don't provide targetSkillsDir and no conventional dir exists
    const result = await installSkillSymlink(repoSkillsDir);

    expect(result.status).toBe("not-found");
    expect(result.message).toBeDefined();
  });

  test("manual instructions message includes the skill source path", async () => {
    const fakeHome = await makeTempDir();
    process.env.HOME = fakeHome;

    const repoSkillsDir = await makeTempDir("wiki-repo-skills-");
    const repoWiki = join(repoSkillsDir, "wiki");
    await mkdir(repoWiki, { recursive: true });

    const result = await installSkillSymlink(repoSkillsDir);

    expect(result.status).toBe("not-found");
    expect(result.message).toContain(repoSkillsDir);
  });
});
