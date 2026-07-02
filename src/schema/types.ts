export type FieldType =
  | "string"
  | "text"
  | "list"
  | "link"
  | "link_list"
  | "enum"
  | "boolean"
  | "date"
  | "integer"
  | "file_ref";

export type Constraints = {
  min?: number;
  max?: number;
  values?: string[];
  pattern?: string;
  target?: string;
  item_type?: FieldType;
  description?: string;
};

export type FieldDef = {
  name: string;
  type: FieldType;
  required: boolean;
  /** The CLI sets this field itself at write time (a template `auto: true`); it is
   *  never a create-time flag and is annotated "auto — omit at create" by `wiki schema`. */
  auto?: boolean;
  constraints: Constraints;
};

export type Schema = {
  template: string;
  version: number;
  fields: FieldDef[];
};

export type NormalizedRecord = Record<string, unknown>;

export type ValidationError = {
  field: string;
  reason: string;
  expected?: string;
};

export type Result<T, E> = { ok: true; value: T } | { ok: false; errors: E };
