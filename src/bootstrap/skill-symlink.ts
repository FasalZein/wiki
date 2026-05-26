import { lstat, readlink, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type SymlinkResult = {
  status: "created" | "exists" | "not-found";
  target?: string;
  link?: string;
  message?: string;
};

const SKILLS_DIRS = [
  "~/.claude/skills",
  "~/.pi/agent/skills",
  "~/.agents/skills",
];

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) return p;
    return join(home, p.slice(2));
  }
  return p;
}

/** Find the first existing skills directory from conventional paths. */
export function detectSkillsDir(): string | null {
  for (const dir of SKILLS_DIRS) {
    const expanded = expandHome(dir);
    if (existsSync(expanded)) return expanded;
  }
  return null;
}

/** Create symlink from repoSkillsDir/wiki into the detected (or provided) skills directory. */
export async function installSkillSymlink(
  repoSkillsDir: string,
  targetSkillsDir?: string,
): Promise<SymlinkResult> {
  const skillsDir = targetSkillsDir ?? detectSkillsDir();

  if (!skillsDir) {
    return {
      status: "not-found",
      message:
        `No conventional skills directory found. ` +
        `Create one of these directories and symlink manually:\n` +
        `  ln -s ${join(repoSkillsDir, "wiki")} ~/.claude/skills/wiki`,
    };
  }

  const linkPath = join(skillsDir, "wiki");
  const targetPath = join(repoSkillsDir, "wiki");

  // Check if symlink already exists
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existingTarget = await readlink(linkPath);
      if (existingTarget === targetPath) {
        return { status: "exists", target: targetPath, link: linkPath };
      }
      // Symlink exists but points elsewhere — don't overwrite
      return {
        status: "exists",
        target: existingTarget,
        link: linkPath,
        message: `Symlink exists but points to ${existingTarget} instead of ${targetPath}`,
      };
    }
  } catch {
    // linkPath doesn't exist — proceed to create
  }

  await symlink(targetPath, linkPath);
  return { status: "created", target: targetPath, link: linkPath };
}
