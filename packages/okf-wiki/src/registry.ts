import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { containedEntry, createExclusive, WikiError } from "./vault.ts";
import { isMapping } from "./frontmatter.ts";
import { inspectContainedPath } from "./paths.ts";
import { missingHeadings, parseMarkdown } from "./markdown.ts";

export interface Diagnostic { path: string; rule: string; message: string; fix: string }
interface Heading { level: number; text: string }
export interface TypeRecord {
  name: string; folder: string; frontmatterSchema: AnySchema;
  requiredHeadings: Heading[]; template: string; scopes?: string[];
}
export interface RegisteredType { record: TypeRecord; validate: ValidateFunction }
const NAME = "[a-z0-9]+(?:-[a-z0-9]+)*";
const RESERVED = new Set(["index", "log", "assets", "projects", "personal", "node-modules", "types", "tmp", "locks"]);
export function safeName(value: string): boolean { return new RegExp("^" + NAME + "$").test(value) && !RESERVED.has(value); }
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true, ownProperties: true });
// The callable CJS export also exposes .default, matching its NodeNext type declaration.
addFormats.default(ajv);
const line = { type: "string", minLength: 1, pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$" };
const date = { type: "string", format: "date-time", pattern: "T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$" };
export const COMMON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
  required: ["type", "title", "description", "created"],
  properties: {
    type: { type: "string", pattern: "^" + NAME + "$" }, title: line, description: line,
    created: date, stale_after: date, resource: line, retrieved: date,
    tags: { type: "array", items: { type: "string", minLength: 1, pattern: "^[^\\p{Uppercase}\\p{Lt}]+$" } },
    status: { enum: ["draft", "stable", "deprecated"] },
    superseded_by: { type: "string", minLength: 1 }, id: false, updated: false,
  },
  allOf: [
    { if: { properties: { type: { const: "source" } }, required: ["type"] }, then: { required: ["resource", "retrieved"] } },
    { if: { required: ["superseded_by"] }, then: { required: ["status"], properties: { status: { const: "deprecated" } } } },
  ],
};
const validRecord = ajv.compile<TypeRecord>({
  type: "object", required: ["name", "folder", "frontmatterSchema", "requiredHeadings", "template"], additionalProperties: false,
  properties: {
    name: { type: "string" }, folder: { type: "string" }, frontmatterSchema: { type: ["object", "boolean"] },
    requiredHeadings: { type: "array", items: { type: "object", required: ["level", "text"], additionalProperties: false,
      properties: { level: { type: "integer", minimum: 1, maximum: 6 }, text: line } } },
    template: { type: "string" }, scopes: { type: "array", uniqueItems: true,
      items: { type: "string", pattern: "^(?:personal|projects/" + NAME + ")$" } },
  },
});
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function sortDiagnostics(items: Diagnostic[]): Diagnostic[] {
  return items.sort((a, b) => compare(a.path, b.path) || compare(a.rule, b.rule) || compare(a.message, b.message));
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function issue(file: string, rule: string, message: string, fix: string): Diagnostic { return { path: file, rule, message, fix }; }
export function openVault(dir: string): string {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) throw new WikiError("not_found", "Missing vault: " + root);
  for (const relative of ["", ".wiki", ".wiki/config.json", ".wiki/types", ".wiki/tmp", "log.md"]) {
    const item = containedEntry(root, relative).stat;
    if (!item) throw new WikiError("damaged", "Missing vault entry: " + relative);
    const directory = ["", ".wiki", ".wiki/types", ".wiki/tmp"].includes(relative);
    if (directory ? !item.isDirectory() : !item.isFile()) throw new WikiError("damaged", "Wrong vault entry kind: " + relative);
  }
  let config: unknown;
  try { config = JSON.parse(fs.readFileSync(path.join(root, ".wiki/config.json"), "utf8")); }
  catch { throw new WikiError("damaged", "Invalid JSON configuration"); }
  if (!isMapping(config) || !("profile" in config) || !("version" in config)) throw new WikiError("damaged", "Invalid configuration");
  if (config.profile !== "wiki-okf" || config.version !== 1) throw new WikiError("unsupported", "Unsupported profile/version; no conversion performed");
  return fs.realpathSync(root);
}

// Visit schema positions, not arbitrary annotation/enum data. Only fragment-local refs are supported.
function checkReferences(schema: unknown): void {
  if (!isMapping(schema)) return;
  for (const key of ["$ref", "$dynamicRef"]) {
    if (key in schema && (typeof schema[key] !== "string" || !schema[key].startsWith("#"))) throw new Error("Only local fragment schema references are allowed");
  }
  if ("$id" in schema && (typeof schema.$id !== "string" || !schema.$id.startsWith("#"))) throw new Error("External schema identifiers are not supported");
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
    const values = schema[key];
    if (isMapping(values)) for (const value of Object.values(values)) checkReferences(value);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const values = schema[key];
    if (Array.isArray(values)) for (const value of values) checkReferences(value);
  }
  for (const key of ["not", "if", "then", "else", "items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "unevaluatedItems", "contentSchema"]) checkReferences(schema[key]);
}
export function loadRegistry(root: string): { types: RegisteredType[]; diagnostics: Diagnostic[] } {
  const types: RegisteredType[] = [], diagnostics: Diagnostic[] = [];
  for (const file of fs.readdirSync(path.join(root, ".wiki/types")).sort()) {
    const relative = ".wiki/types/" + file;
    const fail = (rule: string, text: string, fix = "Repair the registry record and rerun whole-vault lint") => diagnostics.push(issue(relative, rule, text, fix));
    const inspected = inspectContainedPath(root, relative);
    if (!inspected.ok) { fail("registry.file", inspected.problem.message); continue; }
    const stat = inspected.stat;
    if (!stat?.isFile() || !file.endsWith(".json")) { fail("registry.file", "Expected a regular JSON registry file"); continue; }
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")); }
    catch { fail("registry.json", "Malformed JSON registry record"); continue; }
    if (!validRecord(data)) { fail("registry.record", ajv.errorsText(validRecord.errors)); continue; }
    if (!safeName(data.name)) { fail("registry.name", "Unsafe or reserved type name: " + data.name); continue; }
    if (file !== data.name + ".json") { fail("registry.name", "Filename must match registry name " + data.name); continue; }
    if (!safeName(data.folder)) { fail("registry.folder", "Unsafe or reserved folder: " + data.folder); continue; }
    if (data.scopes?.some(scope => scope.startsWith("projects/") && !safeName(scope.slice(9)))) { fail("registry.scopes", "Invalid exact scope restriction"); continue; }
    // Templates are inert Markdown bodies. Only a complete leading frontmatter block
    // crosses that boundary; shell examples, placeholder syntax, and thematic breaks do not.
    if (/^\uFEFF?---(?:[A-Za-z][\w-]*)?[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.test(data.template)) { fail("registry.template", "Template body must not contain a leading frontmatter block"); continue; }
    if (missingHeadings(parseMarkdown(data.template), data.requiredHeadings, data.name).length) { fail("registry.template", "Template is missing a required heading"); continue; }
    try {
      if (isMapping(data.frontmatterSchema) && data.frontmatterSchema.$schema !== undefined && data.frontmatterSchema.$schema !== COMMON_SCHEMA.$schema) throw new Error("Expected JSON Schema draft 2020-12");
      checkReferences(data.frontmatterSchema);
      // Compile each type in isolation: duplicate $ids cannot leak across records or commands.
      const validator = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
      addFormats.default(validator);
      validator.addSchema(data.frontmatterSchema, "urn:wiki:type");
      const validate = validator.compile({ allOf: [COMMON_SCHEMA, { $ref: "urn:wiki:type" }], unevaluatedProperties: false });
      types.push({ record: data, validate });
    } catch (error) { fail("registry.schema", "Invalid or disallowed schema: " + message(error)); }
  }
  for (let i = 0; i < types.length; i++) for (const other of types.slice(i + 1)) {
    const current = types[i];
    const left = current?.record.scopes, right = other.record.scopes;
    const overlaps = (left ?? right)?.some(scope => (!left || left.includes(scope)) && (!right || right.includes(scope))) ?? true;
    if (current && current.record.folder === other.record.folder && overlaps) {
      diagnostics.push(issue(".wiki/types/" + other.record.name + ".json", "registry.folder", "Folder conflicts with type " + current.record.name, "Choose a unique folder in each allowed scope"));
    }
  }
  return { types, diagnostics: sortDiagnostics(diagnostics) };
}
export function listTypes(types: RegisteredType[]) {
  return types.map(({ record }) => ({ name: record.name, folder: record.folder,
    requiredFields: [...new Set([...COMMON_SCHEMA.required, ...(record.name === "source" ? ["resource", "retrieved"] : []), ...requiredFields(record.frontmatterSchema)])],
    requiredHeadings: record.requiredHeadings, ...(record.scopes ? { scopes: record.scopes } : {}) }));
}
function resolveReference(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (ref.startsWith("#/")) {
    let value = root;
    for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!isMapping(value) && !Array.isArray(value)) return undefined;
      value = Object.getOwnPropertyDescriptor(value, key)?.value;
    }
    return value;
  }
  const anchor = decodeURIComponent(ref.slice(1));
  function find(value: unknown): unknown {
    if (!isMapping(value) && !Array.isArray(value)) return undefined;
    if (isMapping(value) && (value.$anchor === anchor || value.$dynamicAnchor === anchor)) return value;
    for (const child of Object.values(value)) { const found = find(child); if (found !== undefined) return found; }
    return undefined;
  }
  return find(root);
}
// Only walk schemas that describe this mapping, never properties of nested values.
function mappingSchemas(root: unknown, conditional: boolean): Record<string, unknown>[] {
  const seen = new Set<unknown>(), result: Record<string, unknown>[] = [];
  function visit(schema: unknown) {
    if (!isMapping(schema) || seen.has(schema)) return;
    seen.add(schema); result.push(schema);
    for (const key of ["$ref", "$dynamicRef"]) if (typeof schema[key] === "string") visit(resolveReference(root, schema[key]));
    for (const key of conditional ? ["allOf", "anyOf", "oneOf"] : ["allOf"]) {
      const children = schema[key];
      if (Array.isArray(children)) for (const child of children) visit(child);
    }
    if (conditional) {
      for (const key of ["if", "then", "else"]) visit(schema[key]);
      if (isMapping(schema.dependentSchemas)) for (const child of Object.values(schema.dependentSchemas)) visit(child);
    }
  }
  visit(root); return result;
}
function requiredFields(schema: unknown): string[] {
  return mappingSchemas(schema, false).flatMap(s => Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === "string") : []);
}
export function declaresProperty(schema: unknown, key: string): boolean {
  if (Object.hasOwn(COMMON_SCHEMA.properties, key)) return true;
  return mappingSchemas(schema, true).some(s =>
    isMapping(s.properties) && Object.hasOwn(s.properties, key) ||
    isMapping(s.patternProperties) && Object.keys(s.patternProperties).some(pattern => new RegExp(pattern, "u").test(key)));
}
export class RegistryWriteError extends WikiError {
  readonly written = true;
  readonly paths: string[];
  readonly digest: string;
  constructor(relative: string, bytes: string) {
    super("damaged", "Registry scaffold was published but its log entry failed; inspect log.md before adding the missing entry manually");
    this.paths = [relative];
    this.digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  }
}
export function addType(root: string, name: string, folder: string): { path: string; digest: string } {
  if (!safeName(name) || !safeName(folder)) throw new WikiError("usage", "Use safe, non-reserved lowercase hyphenated type and folder names");
  const relative = ".wiki/types/" + name + ".json";
  // Preserve exclusive-create conflicts for an existing leaf, including a symlink.
  const directory = containedEntry(root, ".wiki/types").full;
  if (fs.lstatSync(path.join(directory, name + ".json"), { throwIfNoEntry: false })) throw new WikiError("conflict", "Existing registry destination: " + relative);
  const registry = loadRegistry(root);
  if (registry.diagnostics.length) throw new WikiError("damaged", "Repair registry before adding a type: " + registry.diagnostics[0]?.message);
  if (registry.types.some(t => t.record.folder === folder)) throw new WikiError("usage", "Folder conflicts with an existing type: " + folder);
  const scaffold: TypeRecord = { name, folder, frontmatterSchema: { ...COMMON_SCHEMA,
    properties: { ...COMMON_SCHEMA.properties, type: { const: name } }, additionalProperties: false }, requiredHeadings: [], template: "" };
  const bytes = JSON.stringify(scaffold, null, 2) + "\n";
  try { createExclusive(root, relative, bytes); }
  catch (error) {
    if (isMapping(error) && error.code === "EEXIST") throw new WikiError("conflict", "Existing registry destination: " + relative);
    throw error;
  }
  try {
    const log = containedEntry(root, "log.md").full;
    const previous = fs.readFileSync(log, "utf8");
    const heading = "## " + new Date().toISOString().slice(0, 10) + "\n\n";
    const entry = "**type-added** [" + name + "](" + relative + ")\n\n";
    fs.writeFileSync(log, heading + entry + (previous.startsWith(heading) ? previous.slice(heading.length) : previous));
  } catch { throw new RegistryWriteError(relative, bytes); }
  return { path: relative, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}
export function schemaDiagnostics(file: string, errors: ErrorObject[] | null | undefined): Diagnostic[] {
  return (errors ?? []).map(e => issue(file, "frontmatter.schema", (e.instancePath || "/") + " " + e.message + " " + JSON.stringify(e.params), "Correct the field to satisfy the common profile and registered type schema"));
}
