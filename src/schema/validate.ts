import type { FieldDef, NormalizedRecord, Result, Schema, ValidationError } from "./types";

export function validate(
  schema: Schema,
  input: Record<string, unknown>,
): Result<NormalizedRecord, ValidationError[]> {
  const errors: ValidationError[] = [];

  for (const field of schema.fields) {
    if (field.required && input[field.name] === undefined) {
      errors.push({ field: field.name, reason: "required", expected: expectedType(field) });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input };
}

function expectedType(field: FieldDef): string {
  return field.type;
}
