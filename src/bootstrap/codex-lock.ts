export type CodexLockResult = {
  status: "instructions-printed";
  instructions: string;
};

export function codexLockInstructions(vaultPath: string): CodexLockResult {
  const instructions = [
    "Codex vault lock — manual setup required:",
    "",
    `Vault path: ${vaultPath}`,
    "",
    "Add deny rules to your Codex agent config that prevent direct writes",
    "to any path under the vault. The wiki CLI should be the only writer.",
    "",
    "Deny patterns to add:",
    `  - Edit: ${vaultPath}/**`,
    `  - Write: ${vaultPath}/**`,
    `  - Bash redirects to: ${vaultPath}/*`,
    "",
    "Consult Codex documentation for the exact config syntax.",
    "Run 'wiki vault doctor' after setup to verify the lock is active.",
  ].join("\n");

  return { status: "instructions-printed", instructions };
}
