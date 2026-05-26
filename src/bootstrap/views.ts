import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BaseView = {
  type: "table" | "cards" | "list";
  name: string;
  filters?: { and?: string[] };
  groupBy?: { property: string; direction: "ASC" | "DESC" };
  order: string[];
};

export type BaseFile = {
  filters: { and: (string | object)[] };
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName: string }>;
  views: BaseView[];
};

/** Normalize path to forward slashes (Obsidian vault paths are always forward-slash). */
function fwd(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Indent a multi-line string by n spaces. */
function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

function renderOrder(order: string[], indentLevel: number): string {
  const pad = " ".repeat(indentLevel);
  return order.map((col) => `${pad}- ${col}`).join("\n");
}

function renderViewFilters(filters: { and?: string[] }, indentLevel: number): string {
  if (!filters.and || filters.and.length === 0) return "";
  const pad = " ".repeat(indentLevel);
  let out = `${pad}filters:\n`;
  out += `${pad}  and:\n`;
  for (const f of filters.and) {
    out += `${pad}    - '${f}'\n`;
  }
  return out;
}

function renderView(view: BaseView): string {
  let out = `  - type: ${view.type}\n`;
  out += `    name: "${view.name}"\n`;
  if (view.groupBy) {
    out += `    groupBy:\n`;
    out += `      property: ${view.groupBy.property}\n`;
    out += `      direction: ${view.groupBy.direction}\n`;
  }
  if (view.filters) {
    out += renderViewFilters(view.filters, 4);
  }
  out += `    order:\n`;
  out += renderOrder(view.order, 6);
  return out;
}

function renderBase(folderPath: string, properties: Record<string, string>, views: BaseView[], formulas?: Record<string, string>): string {
  let out = "filters:\n";
  out += "  and:\n";
  out += `    - file.inFolder("${folderPath}")\n`;
  out += "\n";

  if (formulas && Object.keys(formulas).length > 0) {
    out += "formulas:\n";
    for (const [key, val] of Object.entries(formulas)) {
      out += `  ${key}: '${val}'\n`;
    }
    out += "\n";
  }

  out += "properties:\n";
  for (const [key, displayName] of Object.entries(properties)) {
    out += `  ${key}:\n`;
    out += `    displayName: ${displayName}\n`;
  }
  out += "\n";

  out += "views:\n";
  out += views.map(renderView).join("\n");
  out += "\n";

  return out;
}

export function generateSlicesBase(projectPath: string): string {
  const folder = `${fwd(projectPath)}/slices`;
  const properties: Record<string, string> = {
    "file.name": "Title",
    status: "Status",
    parent_prd: "PRD",
    type: "Type",
  };
  const views: BaseView[] = [
    {
      type: "table",
      name: "All Slices",
      groupBy: { property: "status", direction: "ASC" },
      order: ["file.name", "status", "parent_prd", "type", "file.mtime"],
    },
    {
      type: "table",
      name: "Active",
      filters: { and: ['status != "closed"'] },
      order: ["file.name", "status", "parent_prd"],
    },
    {
      type: "table",
      name: "By PRD",
      groupBy: { property: "parent_prd", direction: "ASC" },
      order: ["file.name", "status", "type"],
    },
  ];
  return renderBase(folder, properties, views);
}

export function generatePRDsBase(projectPath: string): string {
  const folder = `${fwd(projectPath)}/prds`;
  const properties: Record<string, string> = {
    "file.name": "Title",
    status: "Status",
  };
  const views: BaseView[] = [
    {
      type: "table",
      name: "All PRDs",
      groupBy: { property: "status", direction: "ASC" },
      order: ["file.name", "status", "file.mtime"],
    },
    {
      type: "table",
      name: "Active",
      filters: { and: ['status != "closed"', 'status != "superseded"'] },
      order: ["file.name", "status", "file.mtime"],
    },
  ];
  return renderBase(folder, properties, views);
}

export function generateDecisionsBase(projectPath: string): string {
  const folder = `${fwd(projectPath)}/adrs`;
  const properties: Record<string, string> = {
    "file.name": "Title",
    date: "Date",
    status: "Status",
  };
  const views: BaseView[] = [
    {
      type: "table",
      name: "All Decisions",
      order: ["file.name", "date", "status", "file.mtime"],
    },
  ];
  return renderBase(folder, properties, views);
}

export async function deployViews(vaultRoot: string, project: string): Promise<string[]> {
  const projectDir = join(vaultRoot, "projects", project);
  await mkdir(projectDir, { recursive: true });

  const generators = [
    { name: "Slices.base", fn: generateSlicesBase },
    { name: "PRDs.base", fn: generatePRDsBase },
    { name: "Decisions.base", fn: generateDecisionsBase },
  ];

  const vaultProjectPath = `projects/${project}`;
  const written: string[] = [];

  for (const { name, fn } of generators) {
    const filePath = join(projectDir, name);
    const content = fn(vaultProjectPath);
    await writeFile(filePath, content);
    written.push(filePath);
  }

  return written;
}
