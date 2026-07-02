import type { FieldDef, NormalizedRecord, Result, Schema, ValidationError } from "./types";

export function validate(
  schema: Schema,
  input: Record<string, unknown>,
): Result<NormalizedRecord, ValidationError[]> {
  const errors: ValidationError[] = [];

  for (const field of schema.fields) {
    const value = input[field.name] ?? undefined; // ponytail: gray-matter yields null for a blank key; treat blank as absent
    if (field.required && value === undefined) {
      errors.push({ field: field.name, reason: "required", expected: field.type });
      continue;
    }
    if (value !== undefined && !matchesType(field, value)) {
      errors.push({ field: field.name, reason: "type mismatch", expected: field.type });
      continue;
    }
    if (
      field.type === "enum" &&
      value !== undefined &&
      field.constraints.values !== undefined &&
      // A Date on an enum passes matchesType (date|enum share a clause) but can never
      // be a valid enum value — reject any non-string here, never wave it through.
      (typeof value !== "string" || !field.constraints.values.includes(value))
    ) {
      errors.push({
        field: field.name,
        reason: "invalid enum value",
        expected: `one of: ${field.constraints.values.join(", ")}`,
      });
    }
    if ((field.type === "list" || field.type === "link_list") && Array.isArray(value)) {
      const { min, max } = field.constraints;
      if (min !== undefined && value.length < min) {
        errors.push({ field: field.name, reason: `${value.length} items, min ${min} — add ${min - value.length}`, expected: `at least ${min} item` });
      }
      if (max !== undefined && value.length > max) {
        errors.push({ field: field.name, reason: `${value.length} items, max ${max} — drop ${value.length - max}`, expected: `at most ${max} item` });
      }
    }
    if (isStringLike(field) && typeof value === "string") {
      const { min, max, pattern } = field.constraints;
      if (min !== undefined && value.length < min) {
        errors.push({ field: field.name, reason: `${value.length} chars, min ${min} — add ${min - value.length}`, expected: `at least ${min} characters` });
      }
      if (max !== undefined && value.length > max) {
        errors.push({ field: field.name, reason: `${value.length} chars, max ${max} — trim ${value.length - max}`, expected: `at most ${max} characters` });
      }
      if (pattern !== undefined && !new RegExp(`^${pattern}$`).test(value)) {
        errors.push({ field: field.name, reason: "pattern mismatch", expected: pattern });
      }
    }
    if (field.type === "integer" && typeof value === "number") {
      const { min, max } = field.constraints;
      if (min !== undefined && value < min) {
        errors.push({ field: field.name, reason: `${value}, min ${min}`, expected: `at least ${min}` });
      }
      if (max !== undefined && value > max) {
        errors.push({ field: field.name, reason: `${value}, max ${max}`, expected: `at most ${max}` });
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
      return typeof value === "string" || value instanceof Date;
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
