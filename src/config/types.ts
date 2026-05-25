export type Harness = "pi" | "codex" | "claude-code" | "none";

export type WikiConfig = {
  vault: { root: string };
  research: { sources: string[] };
  harness: { detected: Harness };
};

export type VaultPaths = {
  root: string;
  projects: string;
};
