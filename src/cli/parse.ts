import { parseArgs, type ParseArgsConfig } from "node:util";

/** Thrown when argument parsing fails, with an actionable message (not node internals). */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

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
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options,
    });
  } catch (error) {
    // parseArgs throws raw node-internals errors. The common one is a value that
    // begins with a dash (a title/summary like "-foo"): surface an actionable
    // message naming both fixes instead of the ERR_PARSE_ARGS_* wording.
    const code = (error as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" || code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new ParseError(
        "a value beginning with '-' is ambiguous. Use --flag=value (e.g. --title=-foo) or put the value after a '--' escape so it isn't read as a flag.",
      );
    }
    if (error instanceof Error) throw new ParseError(error.message);
    throw error;
  }
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
