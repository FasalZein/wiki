import { parseArgs } from "node:util";

export type ParsedValues = Record<string, string | boolean | string[] | undefined>;

export type ParsedCommand = {
  positionals: string[];
  values: ParsedValues;
};

export function parseCommand(args: string[], stringFlags: string[]): ParsedCommand {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: Object.fromEntries(stringFlags.map((flag) => [flag, { type: "string" }])),
  });
  return {
    positionals: parsed.positionals.length > 0 ? parsed.positionals : trailingPositionals(parsed.tokens),
    values: parsed.values,
  };
}

function trailingPositionals(tokens: Exclude<ReturnType<typeof parseArgs>["tokens"], undefined>): string[] {
  const marker = tokens.findIndex((token) => token.kind === "option-terminator");
  if (marker === -1) {
    return [];
  }
  return tokens.slice(marker + 1).flatMap((token) => (token.kind === "positional" ? [token.value] : []));
}

export function stringValue(values: ParsedValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}
