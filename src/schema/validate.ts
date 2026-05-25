import type { NormalizedRecord, Result, Schema, ValidationError } from "./types";

export function validate(
  _schema: Schema,
  input: Record<string, unknown>,
): Result<NormalizedRecord, ValidationError[]> {
  return { ok: true, value: input };
}
