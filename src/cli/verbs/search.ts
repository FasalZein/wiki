import { parseCommand } from "../parse";
import type { CliResult } from "../dispatch";

export async function handleSearch(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"]);
  const query = parsed.positionals[0]?.trim();
  if (query === undefined || query.length === 0) {
    console.error("missing required field: query");
    return { code: 1 };
  }
  return { code: 0 };
}
