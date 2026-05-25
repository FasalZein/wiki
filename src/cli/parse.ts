import { parseArgs } from "node:util";

export type ParsedCommand = {
  positionals: string[];
  values: Record<string, string | boolean | string[]>;
};

export function parseCommand(args: string[], stringFlags: string[]): ParsedCommand {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(stringFlags.map((flag) => [flag, { type: "string" }])),
  });
  return {
    positionals: parsed.positionals,
    values: parsed.values,
  };
}

export function stringValue(values: Record<string, string | boolean | string[]>, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}
