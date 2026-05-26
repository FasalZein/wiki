/**
 * Thin Obsidian CLI integration. All vault mutations go through the Obsidian
 * CLI binary, which auto-launches Obsidian when invoked.
 *
 * Binary resolution: OBSIDIAN_BIN env var, then default `obsidian`.
 *
 * The Obsidian CLI always exits 0 — errors are signalled by stdout starting
 * with "Error:". Every function that expects clean output checks for this
 * prefix and throws ObsidianError when detected.
 */

export class ObsidianNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsidianNotRunningError";
  }
}

export class ObsidianError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObsidianError";
  }
}

function bin(): string {
  return process.env.OBSIDIAN_BIN ?? "obsidian";
}

async function runObsidian(args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  } catch (error) {
    throw new ObsidianError(error instanceof Error ? error.message : String(error));
  }
  const [stdout, _stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new ObsidianError(`obsidian exited ${exitCode}`);
  }
  const trimmed = stdout.trimEnd();
  if (trimmed.startsWith("Error:")) {
    throw new ObsidianError(trimmed);
  }
  return trimmed;
}

export async function ensureObsidian(): Promise<void> {
  try {
    await runObsidian(["version"]);
  } catch (error) {
    if (error instanceof ObsidianError) {
      throw new ObsidianNotRunningError(error.message);
    }
    throw new ObsidianNotRunningError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function isObsidianRunning(): Promise<boolean> {
  try {
    await ensureObsidian();
    return true;
  } catch {
    return false;
  }
}

export async function obsidianCreate(
  name: string,
  content: string,
  folder: string,
  opts?: { silent?: boolean; overwrite?: boolean },
): Promise<string> {
  const args = ["create", `name=${name}`, `content=${content}`, `folder=${folder}`];
  if (opts?.silent) args.push("silent");
  if (opts?.overwrite) args.push("overwrite");
  const output = await runObsidian(args);
  return output.startsWith("Created: ") ? output.slice(9) : output;
}

export async function obsidianRead(path: string): Promise<string> {
  return runObsidian(["read", `path=${path}`]);
}

export async function obsidianAppend(path: string, content: string): Promise<void> {
  await runObsidian(["append", `path=${path}`, `content=${content}`]);
}

export async function obsidianPropertySet(
  path: string,
  name: string,
  value: string,
  type?: string,
): Promise<void> {
  const args = ["property:set", `path=${path}`, `name=${name}`, `value=${value}`];
  if (type !== undefined) args.push(`type=${type}`);
  await runObsidian(args);
}

export async function obsidianPropertyRead(path: string, name: string): Promise<string> {
  return runObsidian(["property:read", `path=${path}`, `name=${name}`]);
}

export async function obsidianSearch(
  query: string,
  opts?: { limit?: number; format?: string },
): Promise<string> {
  const args = ["search", `query=${query}`];
  if (opts?.limit !== undefined) args.push(`limit=${opts.limit}`);
  if (opts?.format !== undefined) args.push(`format=${opts.format}`);
  return runObsidian(args);
}

export async function obsidianEval(code: string): Promise<string> {
  const output = await runObsidian(["eval", `code=${code}`]);
  return output.startsWith("=> ") ? output.slice(3) : output;
}

export async function obsidianPluginInstall(id: string): Promise<void> {
  await runObsidian(["plugin:install", `id=${id}`]);
}

export async function obsidianPluginEnable(id: string): Promise<void> {
  await runObsidian(["plugin:enable", `id=${id}`]);
}

export async function obsidianCommand(id: string): Promise<void> {
  await runObsidian(["command", `id=${id}`]);
}
