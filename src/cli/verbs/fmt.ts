import { readdir, readFile, rename } from "node:fs/promises";
import { join, relative } from "node:path";

import matter from "gray-matter";

import { orderBySchema } from "../../artifacts/render";
import { bodySectionDrift } from "../../artifacts/body";
import { loadStructure, type Structure } from "../../artifacts/registry";
import { slugifyTitle } from "../../artifacts/store";
import { projectPath } from "../../artifacts/paths";
import { assertProjectStructure, loadProjectConfig, ProjectConfigError, projectErrorMessage } from "../../config/project";
import { getVaultRoot } from "../../config/vault";
import { loadTemplate, normalizeInlineMaps, resolveTemplatePath, type TemplateType } from "../../schema/load";
import { booleanValue, parseCommand } from "../parse";
import { resolveProject } from "../resolve-project";
import { emitJson, jsonEnabled } from "../output";
import type { CliResult } from "../dispatch";

/**
 * Formatter seam: each fix category takes the file content and returns the
 * violations it found plus the content with its fixes applied. check reports
 * the violations; --write persists the transformed content. Later slices plug
 * in additional categories.
 */
type CategoryResult = { labels: string[]; fixed: string };
type Category = (content: string, file: string, structure: Structure) => CategoryResult | Promise<CategoryResult>;

const CATEGORIES: Category[] = [fixDates, fixTemplaterBlocks, fixAcceptanceEach, fixClosedSliceTodos, fixFrontmatterShape];

export async function handleFmt(args: string[]): Promise<CliResult> {
  const parsed = parseCommand(args, ["project"], [], ["write"]);
  const project = await resolveProject(parsed);
  if (project === undefined) {
    console.error("missing required field: project (pass --project or link the repo with wiki project link)");
    return { code: 1 };
  }

  const vaultRoot = await getVaultRoot();
  const structure = await loadStructure(vaultRoot);
  const projPath = projectPath(vaultRoot, project);
  try {
    await loadProjectConfig(projPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(await projectErrorMessage(vaultRoot, project));
      return { code: 10 };
    }
    throw error;
  }
  await assertProjectStructure(projPath, structure);

  const write = booleanValue(parsed.values, "write");
  const result = await applyFmtFixes(vaultRoot, projPath, write, structure);
  const { total, manual, renumberMap } = result;

  if (jsonEnabled()) {
    const clean = total === 0 && manual.length === 0;
    emitJson({
      project,
      mode: write ? "write" : "check",
      clean,
      fixed: write ? total : 0,
      pending: write ? 0 : total,
      manual,
      renumbered: [...renumberMap].map(([from, to]) => ({ from, to })),
    });
    // check-mode with outstanding drift is a non-zero exit even in json mode.
    return { code: !write && !clean ? 1 : 0 };
  }

  for (const label of result.labels) {
    console.log(write ? `fixed ${label}` : label);
  }

  if (total === 0 && manual.length === 0) {
    console.log("clean");
    return { code: 0 };
  }
  if (write) {
    if (total > 0) console.log(`fixed ${total} violation(s)`);
    if (renumberMap.size > 0) {
      console.log("renumbered:");
      for (const [oldId, newId] of renumberMap) {
        console.log(`  ${oldId} -> ${newId}`);
      }
      console.log(`run wiki sync --project ${project} to re-embed — search still references the old ids`);
    }
    if (manual.length > 0) {
      console.log("needs manual attention:");
      for (const finding of manual) {
        console.log(`  ${finding}`);
      }
    }
    return { code: 0 };
  }
  for (const finding of manual) {
    console.log(finding);
  }
  console.log(`${total + manual.length} finding(s) — run wiki fmt --write --project ${project} to fix the mechanical ones`);
  return { code: 1 };
}

/** What {@link applyFmtFixes} resolved: the ordered fix labels (renumber, rename,
 *  then per-file categories), the count of applied/applicable fixes, the
 *  manual-attention findings (collisions + flag-only diagnostics), and the
 *  legacy-id renumber map. */
export type FmtFixResult = {
  labels: string[];
  total: number;
  manual: string[];
  renumberMap: Map<string, string>;
};

/**
 * The formatter's whole fix pipeline for one project, decoupled from CLI output
 * so both `wiki fmt` and `wiki doctor --fix` drive the same mechanical fixes
 * (SLICE-0122): legacy-id renumber (with vault-wide reference rewrite) -> rename
 * to id-slug -> the per-file category pipeline. With `write` false it reports
 * only; with `write` true it persists. Renumbering runs first so the rest of the
 * pipeline sees the post-rename world.
 */
export async function applyFmtFixes(
  vaultRoot: string,
  projPath: string,
  write: boolean,
  structure: Structure,
): Promise<FmtFixResult> {
  const labels: string[] = [];
  let total = 0;

  const renumber = await renumberLegacyIds(vaultRoot, projPath, write, structure);
  total += renumber.labels.length;
  labels.push(...renumber.labels);
  const manual: string[] = [...renumber.collisions];

  const renamed = await renameToId(vaultRoot, projPath, write, structure);
  total += renamed.labels.length;
  labels.push(...renamed.labels);
  manual.push(...renamed.collisions);

  for (const filePath of await markdownFiles(projPath)) {
    const raw = await readFile(filePath, "utf8");
    const file = relative(vaultRoot, filePath);
    let content = raw;
    const fileLabels: string[] = [];
    for (const category of CATEGORIES) {
      const result = await category(content, file, structure);
      fileLabels.push(...result.labels);
      content = result.fixed;
    }
    for (const diagnostic of DIAGNOSTICS) {
      manual.push(...(await diagnostic(content, file, structure)));
    }
    if (fileLabels.length === 0) continue;
    total += fileLabels.length;
    labels.push(...fileLabels);
    if (write) {
      await writeBack(filePath, content);
    }
  }

  return { labels, total, manual, renumberMap: renumber.map };
}

/**
 * Flag-only diagnostics (SLICE-0061): judgment calls the formatter surfaces
 * with a manual-fix hint but never touches. They fail --check; --write lists
 * them under "needs manual attention" and still exits 0.
 */
type Diagnostic = (content: string, file: string, structure: Structure) => string[] | Promise<string[]>;

const DIAGNOSTICS: Diagnostic[] = [
  diagnoseIdentity,
  diagnoseCoreFields,
  diagnoseBodySections,
  diagnoseLinkListProse,
  diagnoseNarrativeFrontmatter,
  diagnoseGuidanceOnlySections,
];

function artifactTypeOf(file: string, structure: Structure): TemplateType | undefined {
  return structure.artifactTypeForVaultPath(file);
}

function diagnoseIdentity(content: string, file: string, structure: Structure): string[] {
  if (artifactTypeOf(file, structure) === undefined) return [];
  const id = frontmatterOf(content)?.id;
  if (typeof id !== "string") {
    return [`${file}: no id in frontmatter (pre-schema artifact) — hint: assign the next free id, fill the schema fields, and rename the file to <ID>-<slug>.md`];
  }
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (!base.startsWith(`${id}-`) && base !== `${id}.md`) {
    return [`${file}: filename does not start with its id — hint: rename to ${id}-<slug>.md`];
  }
  return [];
}

async function diagnoseCoreFields(content: string, file: string, structure: Structure): Promise<string[]> {
  const type = artifactTypeOf(file, structure);
  if (type === undefined) return [];
  const data = frontmatterOf(content);
  if (data === undefined || typeof data.id !== "string") return []; // identity covers
  const schema = await loadTemplate(type);
  const missing = schema.fields
    .filter((field) => field.required && field.name !== "id") // id is identity's job
    .filter((field) => data[field.name] === undefined)
    .map((field) => field.name);
  if (missing.length === 0) return [];
  return [`${file}: missing required fields: ${missing.join(", ")} — hint: set them with 'wiki set <id> <field> <value>'`];
}

/**
 * Body-section drift (SLICE-0087): a required H2 section removed (or an unknown
 * one added) after an edit. Reuses the same template-derived contract validate
 * uses, so the two never disagree. Flag-only — authoring is a judgment call.
 */
async function diagnoseBodySections(content: string, file: string, structure: Structure): Promise<string[]> {
  const type = artifactTypeOf(file, structure);
  if (type === undefined) return [];
  const data = frontmatterOf(content);
  if (data === undefined || typeof data.id !== "string") return []; // identity covers id-less files
  const schema = await loadTemplate(type);
  const templateBody = matter(normalizeInlineMaps(await Bun.file(resolveTemplatePath(`${type}.md`)).text())).content;
  const fieldNames = new Set(schema.fields.map((field) => field.name));
  const drift = bodySectionDrift(templateBody, fieldNames, matter(content).content);
  const findings: string[] = [];
  for (const heading of drift.missing) {
    findings.push(`${file}: missing required body section "## ${heading}" — hint: add the section back`);
  }
  for (const heading of drift.unknown) {
    findings.push(`${file}: unknown body section "## ${heading}" (not in the ${type} template) — hint: remove or rename it`);
  }
  return findings;
}

const ARTIFACT_ID = /^[A-Z]+-\d+$/;

async function diagnoseLinkListProse(content: string, file: string, structure: Structure): Promise<string[]> {
  const type = artifactTypeOf(file, structure);
  if (type === undefined) return [];
  const data = frontmatterOf(content);
  if (data === undefined || typeof data.id !== "string") return [];
  const schema = await loadTemplate(type);
  const findings: string[] = [];
  for (const field of schema.fields) {
    if (field.type !== "link_list") continue;
    const value = data[field.name];
    if (!Array.isArray(value)) continue;
    if (value.some((item) => !ARTIFACT_ID.test(String(item)))) {
      findings.push(`${file}: ${field.name} contains prose instead of artifact ids — hint: replace each entry with the referenced artifact id (e.g. ADR-0009)`);
    }
  }
  return findings;
}

function diagnoseNarrativeFrontmatter(content: string, file: string, structure: Structure): string[] {
  if (artifactTypeOf(file, structure) !== "decision") return [];
  const data = frontmatterOf(content);
  if (data === undefined) return [];
  const narrative = ["context", "decision", "consequences", "alternatives"].filter(
    (name) => typeof data[name] === "string",
  );
  if (narrative.length === 0) return [];
  return [`${file}: narrative stored in frontmatter (${narrative.join(", ")}) — hint: move it into the body ## Context / ## Decision / ## Consequences sections and drop the fields`];
}

function diagnoseGuidanceOnlySections(content: string, file: string, structure: Structure): string[] {
  if (artifactTypeOf(file, structure) !== "prd") return [];
  const findings: string[] = [];
  let section: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (section === undefined) return;
    const filled = lines.filter((line) => line.trim() !== "");
    if (filled.length > 0 && filled.every((line) => line.startsWith(">"))) {
      findings.push(`${file}: section "${section}" contains only template guidance — hint: author the section or deliberately keep the PRD in draft status`);
    }
  };
  for (const line of content.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null) {
      flush();
      section = heading[1];
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return findings;
}

/**
 * Legacy 3-digit PRD/SLICE ids (the padding split) get renamed to uniform
 * 4-digit ids: file rename plus a vault-wide word-boundary rewrite of every
 * cross-reference (frontmatter link fields, aliases, body prose). A legacy id
 * whose padded form is already taken is skipped and flagged — never clobbered.
 */
async function renumberLegacyIds(
  vaultRoot: string,
  projectPath: string,
  write: boolean,
  structure: Structure,
): Promise<{ labels: string[]; collisions: string[]; map: Map<string, string> }> {
  const labels: string[] = [];
  const collisions: string[] = [];
  const map = new Map<string, string>();
  // Legacy short-id pattern over every configured prefix, derived from the
  // structure so any kind is covered, not just PRD/SLICE.
  const legacyId = new RegExp(`^(${Object.keys(structure.kinds).map((k) => structure.specFor(k as TemplateType).prefix).join("|")})-(\\d{3})$`);

  const files = await markdownFiles(projectPath);
  const idToPath = new Map<string, string>();
  for (const filePath of files) {
    const id = frontmatterOf(await readFile(filePath, "utf8"))?.id;
    if (typeof id === "string") idToPath.set(id, filePath);
  }

  for (const [id, filePath] of idToPath) {
    const legacy = legacyId.exec(id);
    if (legacy === null || legacy[1] === undefined || legacy[2] === undefined) continue;
    const newId = `${legacy[1]}-0${legacy[2]}`;
    const file = relative(vaultRoot, filePath);
    if (idToPath.has(newId)) {
      collisions.push(`${file}: collision — ${id} cannot become ${newId} (id already taken); resolve manually`);
      continue;
    }
    labels.push(`${file}: legacy 3-digit id ${id} -> ${newId}`);
    map.set(id, newId);
  }

  if (!write || map.size === 0) return { labels, collisions, map };

  // Rewrite references everywhere first, then rename the files themselves.
  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    let content = raw;
    for (const [oldId, newId] of map) {
      content = content.replace(new RegExp(`\\b${oldId}(?!\\d)`, "g"), newId);
    }
    if (content !== raw) {
      await writeBack(filePath, content);
    }
  }
  for (const [oldId, newId] of map) {
    const filePath = idToPath.get(oldId);
    if (filePath === undefined) continue;
    const rel = relative(vaultRoot, filePath);
    const folder = rel.slice(0, rel.lastIndexOf("/"));
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const newBase = base.replace(new RegExp(`^${oldId}(?!\\d)`), newId);
    await rename(filePath, join(vaultRoot, folder, newBase));
  }

  return { labels, collisions, map };
}

/**
 * Rename a file to ${id}-${slug}.md when its frontmatter id/slug mismatch the
 * filename. The id is kept, so [[id]] links (resolved through the id index)
 * survive the rename. id-less files are left to diagnoseIdentity (flag-only) —
 * never auto-named, since inventing an id is a judgment call. A target name
 * already taken by another file is skipped and flagged, never clobbered.
 */
async function renameToId(
  vaultRoot: string,
  projectPath: string,
  write: boolean,
  structure: Structure,
): Promise<{ labels: string[]; collisions: string[] }> {
  const labels: string[] = [];
  const collisions: string[] = [];

  for (const filePath of await markdownFiles(projectPath)) {
    const file = relative(vaultRoot, filePath);
    if (artifactTypeOf(file, structure) === undefined) continue;
    const data = frontmatterOf(await readFile(filePath, "utf8"));
    const id = data?.id;
    const title = data?.title;
    if (typeof id !== "string" || typeof title !== "string") continue; // id-less / titleless: flag-only
    const expected = `${id}-${slugifyTitle(title)}.md`;
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    const base = filePath.slice(filePath.lastIndexOf("/") + 1);
    if (base === expected) continue;
    const target = join(dir, expected);
    if (await fileExists(target)) {
      collisions.push(`${file}: cannot rename to ${expected} (name already taken); resolve manually`);
      continue;
    }
    labels.push(`${file}: filename does not match id-slug -> ${expected}`);
    if (write) await rename(filePath, target);
  }

  return { labels, collisions };
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/** Legacy short-id pattern over every registered prefix — derived per-vault from
 *  the structure inside renumberLegacyIds, so any kind is covered. */

function fixDates(content: string, file: string): CategoryResult {
  const labels: string[] = [];
  const lines = content.split("\n");
  if (lines[0] !== "---") return { labels, fixed: content };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "---") break;
    const match = /^(\w+): (.+)$/.exec(line);
    if (match === null) continue;
    const [, field, value] = match;
    if (field === undefined || value === undefined) continue;
    if (/^'\d{4}-\d{2}-\d{2}'$/.test(value)) continue; // canonical
    const drift = /^"?(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?"?$/.exec(value);
    if (drift === null || drift[1] === undefined) continue;
    labels.push(`${file}: ${field}: ${value} -> '${drift[1]}'`);
    lines[i] = `${field}: '${drift[1]}'`;
  }
  return { labels, fixed: lines.join("\n") };
}

/**
 * HTML-comment-wrapped Templater scripts execute in Obsidian on file creation
 * and prompt the user (SLICE-0058). The renderer now strips them at create
 * time; this cleans the files that leaked before the fix.
 */
const TEMPLATER_BLOCK = /<!--\s*<%\*[\s\S]*?-->\n*/g;

function fixTemplaterBlocks(content: string, file: string): CategoryResult {
  if (!TEMPLATER_BLOCK.test(content)) return { labels: [], fixed: content };
  TEMPLATER_BLOCK.lastIndex = 0;
  return {
    labels: [`${file}: templater comment block (executable template code)`],
    fixed: content.replace(TEMPLATER_BLOCK, ""),
  };
}

/** Expand a literal {{#each acceptance}} block from the frontmatter list. */
const EACH_ACCEPTANCE = /{{#each acceptance}}[\s\S]*?{{\/each}}\n?/g;

function fixAcceptanceEach(content: string, file: string): CategoryResult {
  if (!EACH_ACCEPTANCE.test(content)) return { labels: [], fixed: content };
  EACH_ACCEPTANCE.lastIndex = 0;
  const acceptance = frontmatterOf(content)?.acceptance;
  const items = Array.isArray(acceptance) ? acceptance.map(String) : [];
  const rendered = items.map((item) => `- [ ] ${item}`).join("\n") + (items.length > 0 ? "\n" : "");
  return {
    labels: [`${file}: unrendered {{#each acceptance}} block`],
    fixed: content.replace(EACH_ACCEPTANCE, rendered),
  };
}

/** Closed slices predating the checkbox gate keep unchecked Todo scaffolding. */
function fixClosedSliceTodos(content: string, file: string): CategoryResult {
  if (!file.includes("/slices/")) return { labels: [], fixed: content };
  if (frontmatterOf(content)?.status !== "closed") return { labels: [], fixed: content };
  const lines = content.split("\n");
  let inTodo = false;
  let ticked = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^## /.test(line)) {
      inTodo = /^## Todo\s*$/.test(line);
      continue;
    }
    if (inTodo && line.startsWith("- [ ] ")) {
      lines[i] = `- [x] ${line.slice(6)}`;
      ticked++;
    }
  }
  if (ticked === 0) return { labels: [], fixed: content };
  return {
    labels: [`${file}: ${ticked} unchecked todo(s) in closed slice`],
    fixed: lines.join("\n"),
  };
}

/**
 * Frontmatter shape (SLICE-0059): aliases backfilled to [<ID>] where missing,
 * fields in schema declaration order (id first), unknown fields preserved
 * after the schema fields. Skips files outside artifact folders and files
 * without an id (pre-schema artifacts are flag-only territory).
 */
async function fixFrontmatterShape(content: string, file: string, structure: Structure): Promise<CategoryResult> {
  const noop = { labels: [], fixed: content };
  const type = artifactTypeOf(file, structure);
  if (type === undefined || !content.startsWith("---")) return noop;

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return noop;
  }
  const data = { ...(parsed.data as Record<string, unknown>) };
  const id = data.id;
  if (typeof id !== "string") return noop;

  const labels: string[] = [];
  if (data.aliases === undefined) {
    data.aliases = [id];
    labels.push(`${file}: missing aliases (backfilled [${id}])`);
  }

  const schema = await loadTemplate(type);
  const originalKeys = Object.keys(parsed.data).join(" ");
  const orderedOriginalKeys = Object.keys(orderBySchema(schema, parsed.data as Record<string, unknown>)).join(" ");
  if (originalKeys !== orderedOriginalKeys) {
    labels.push(`${file}: frontmatter field order differs from schema order`);
  }
  if (labels.length === 0) return noop;

  return { labels, fixed: matter.stringify(parsed.content.trimStart(), orderBySchema(schema, data)) };
}

function frontmatterOf(content: string): Record<string, unknown> | undefined {
  try {
    return matter(content).data as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files.sort();
}

async function writeBack(filePath: string, content: string): Promise<void> {
  await Bun.write(filePath, content);
}
