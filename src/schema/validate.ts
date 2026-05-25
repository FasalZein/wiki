import type { FieldDef, NormalizedRecord, Result, Schema, ValidationError } from "./types";

export function validate(
  schema: Schema,
  input: Record<string, unknown>,
): Result<NormalizedRecord, ValidationError[]> {
  const errors: ValidationError[] = [];

  for (const field of schema.fields) {
    const value = input[field.name];
    if (field.required && value === undefined) {
      errors.push({ field: field.name, reason: "required", expected: expectedType(field) });
      continue;
    }
    if (value !== undefined && !matchesType(field, value)) {
      errors.push({ field: field.name, reason: "type mismatch", expected: expectedType(field) });
      continue;
    }
    if (
      field.type === "enum" &&
      typeof value === "string" &&
      field.constraints.values !== undefined &&
      !field.constraints.values.includes(value)
    ) {
      errors.push({
        field: field.name,
        reason: "invalid enum value",
        expected: `one of: ${field.constraints.values.join(", ")}`,
      });
    }
    if ((field.type === "list" || field.type === "link_list") && Array.isArray(value)) {
      const min = field.constraints.min;
      if (min !== undefined && value.length < min) {
        errors.push({ field: field.name, reason: "below minimum count", expected: `at least ${min} item` });
      }
    }
    if (isStringLike(field) && typeof value === "string") {
      const min = field.constraints.min;
      if (min !== undefined && value.length < min) {
        errors.push({ field: field.name, reason: "below minimum length", expected: `at least ${min} characters` });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input };
}

function matchesType(field: FieldDef, value: unknown): boolean {
  switch (field.type) {
    case "string":
    case "text":
    case "link":
    case "enum":
    case "date":
    case "file_ref":
      return typeof value === "string";
    case "list":
    case "link_list":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
  }
}

function isStringLike(field: FieldDef): boolean {
  return field.type === "string" || field.type === "text" || field.type === "link" || field.type === "file_ref";
}

function expectedType(field: FieldDef): string {
  return field.type;
}
