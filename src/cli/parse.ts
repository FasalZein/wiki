import { parseArgs, type ParseArgsConfig } from "node:util";

export type ParsedValues = Record<string, string | boolean | string[] | undefined>;

export type ParsedCommand = {
  positionals: string[];
  values: ParsedValues;
};

export function parseCommand(
  args: string[],
  stringFlags: string[],
  multipleFlags: string[] = [],
  booleanFlags: string[] = [],
): ParsedCommand {
  const multiple = new Set(multipleFlags);
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const flag of stringFlags) {
    options[flag] = { type: "string", multiple: multiple.has(flag) };
  }
  for (const flag of booleanFlags) {
    options[flag] = { type: "boolean" };
  }
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options,
  });
  return {
    positionals: parsed.positionals.length > 0 ? parsed.positionals : trailingPositionals(parsed.tokens ?? []),
    values: normalizeValues(parsed.values),
  };
}

function normalizeValues(values: ReturnType<typeof parseArgs>["values"]): ParsedValues {
  const normalized: ParsedValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      normalized[key] = value.flatMap((item) => (typeof item === "string" ? [item] : []));
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
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

export function booleanValue(values: ParsedValues, name: string): boolean {
  return values[name] === true;
}
