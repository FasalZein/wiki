import { WikiError } from "./vault.ts";
import { runTool } from "./extract-process.ts";

// Adapted from wiki-core Pandoc text rendering; no evidence or storage policy.
const INLINE_SEQUENCE = new Set(["Emph", "Strong", "Underline", "Strikeout", "Superscript", "Subscript", "SmallCaps"]);
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asBlocks(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new WikiError("unsupported", "pandoc AST blocks are not a list; refusing to invent text");
  return value;
}

function joinBlocks(parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

function renderInlines(value: unknown, limitations: Set<string>): string {
  if (!Array.isArray(value)) throw new WikiError("unsupported", "pandoc AST inlines are not a list; refusing to invent text");
  let text = "";
  for (const node of value) {
    if (!isObject(node) || typeof node.t !== "string") {
      throw new WikiError("unsupported", "pandoc AST inline is not an object; refusing to invent text");
    }
    const tag = node.t;
    if (tag === "Str") {
      if (typeof node.c !== "string") throw new WikiError("unsupported", "pandoc Str node is not text; refusing to invent text");
      text += node.c;
    } else if (tag === "Space" || tag === "SoftBreak" || tag === "LineBreak") {
      emptyNode(node);
      text += tag === "Space" ? " " : "\n";
    }
    else if (tag === "Code") {
      const content = tuple(node.c, 2);
      attributes(content[0]);
      const code = content[1];
      if (typeof code !== "string") throw new WikiError("unsupported", "pandoc Code node has an unexpected shape; refusing to invent text");
      text += code;
    } else if (INLINE_SEQUENCE.has(tag)) {
      // Emph, Strong, and the other nodes in this set store children directly on `c`.
      text += renderInlines(node.c, limitations);
    } else if (tag === "Link" || tag === "Span" || tag === "Image" || tag === "Quoted") {
      const content = tuple(node.c, tag === "Link" || tag === "Image" ? 3 : 2);
      if (tag === "Quoted") {
        if (!isObject(content[0]) || !["SingleQuote", "DoubleQuote"].includes(String(content[0].t))) throw shapeError();
      } else attributes(content[0]);
      if (tag === "Link" || tag === "Image") stringPair(content[2]);
      text += renderInlines(content[1], limitations);
    } else if (tag === "RawInline") {
      stringPair(node.c);
      limitations.add("omitted RawInline; raw HTML was not extracted or executed");
    } else {
      throw new WikiError("unsupported", `pandoc AST inline ${tag} is not extracted; refusing to drop or invent its text`);
    }
  }
  return text;
}

function shapeError(): WikiError {
  return new WikiError("unsupported", "pandoc AST node has an unexpected shape; refusing to invent text");
}
function emptyNode(node: Record<string, unknown>): void {
  if (node.c !== undefined) throw shapeError();
}
function stringPair(value: unknown): void {
  if (!tuple(value, 2).every(item => typeof item === "string")) throw shapeError();
}
function attributes(value: unknown): void {
  const attr = tuple(value, 3);
  if (typeof attr[0] !== "string" || !Array.isArray(attr[1]) || !attr[1].every(item => typeof item === "string") || !Array.isArray(attr[2])) throw shapeError();
  for (const pair of attr[2]) stringPair(pair);
}

function tuple(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new WikiError("unsupported", "pandoc AST node has an unexpected shape; refusing to invent text");
  return value;
}

function renderCaption(value: unknown, limitations: Set<string>): string {
  const caption = tuple(value, 2);
  const short = caption[0] === null ? "" : renderInlines(caption[0], limitations);
  const long = renderBlocks(caption[1], limitations);
  return long || short;
}

function renderTable(value: unknown, limitations: Set<string>): string {
  // Walk the documented Table/Row/Cell structure, not arbitrary arrays: a malformed
  // cell must fail instead of disappearing from an otherwise successful extraction.
  const table = tuple(value, 6);
  const lines = [renderCaption(table[1], limitations)];
  const rows = (value: unknown): void => {
    for (const row of asBlocks(value)) {
      const cells = tuple(row, 2)[1];
      for (const cell of asBlocks(cells)) lines.push(renderBlocks(tuple(cell, 5)[4], limitations));
    }
  };
  rows(tuple(table[3], 2)[1]);
  for (const body of asBlocks(table[4])) {
    const sections = tuple(body, 4);
    rows(sections[2]); rows(sections[3]);
  }
  rows(tuple(table[5], 2)[1]);
  return joinBlocks(lines);
}

function renderFigure(value: unknown, limitations: Set<string>): string {
  const figure = tuple(value, 3);
  attributes(figure[0]);
  return joinBlocks([renderCaption(figure[1], limitations), renderBlocks(figure[2], limitations)]);
}

function renderBlock(block: unknown, limitations: Set<string>): string {
  if (!isObject(block) || typeof block.t !== "string") {
    throw new WikiError("unsupported", "pandoc AST block is not an object; refusing to invent text");
  }
  const tag = block.t;
  const body = block.c;
  switch (tag) {
    case "Para":
    case "Plain":
      return renderInlines(body, limitations);
    case "Header": {
      const header = tuple(body, 3);
      if (!Number.isInteger(header[0])) throw shapeError();
      attributes(header[1]);
      return renderInlines(header[2], limitations);
    }
    case "CodeBlock": {
      const content = tuple(body, 2);
      attributes(content[0]);
      const code = content[1];
      if (typeof code !== "string") throw new WikiError("unsupported", "pandoc CodeBlock has an unexpected shape; refusing to invent text");
      return code.endsWith("\n") ? code.slice(0, -1) : code;
    }
    case "BlockQuote":
      return renderBlocks(body, limitations);
    case "Div": {
      const div = tuple(body, 2); attributes(div[0]);
      return renderBlocks(div[1], limitations);
    }
    case "BulletList":
      return joinBlocks(asBlocks(body).map((item) => renderBlocks(item, limitations)));
    case "OrderedList":
      return joinBlocks(asBlocks(tuple(body, 2)[1]).map((item) => renderBlocks(item, limitations)));
    case "LineBlock":
      return joinBlocks(asBlocks(body).map((item) => renderInlines(item, limitations)));
    case "Table":
      return renderTable(body, limitations);
    case "Figure":
      return renderFigure(body, limitations);
    case "HorizontalRule":
      emptyNode(block);
      return "";
    case "RawBlock":
      stringPair(body);
      limitations.add("omitted RawBlock; raw HTML was not extracted or executed");
      return "";
    default:
      throw new WikiError("unsupported", `pandoc AST block ${tag} is not extracted; refusing to drop or invent its text`);
  }
}

function renderBlocks(value: unknown, limitations: Set<string>): string {
  return joinBlocks(asBlocks(value).map((block) => renderBlock(block, limitations)));
}

function renderTitle(meta: unknown, limitations: Set<string>): string {
  if (!isObject(meta)) throw new WikiError("unsupported", "pandoc metadata is not an object; refusing to invent text");
  if (meta.title === undefined) return "";
  if (!isObject(meta.title)) throw new WikiError("unsupported", "pandoc title is not an object; refusing to invent text");
  const title = meta.title;
  if (title.t === "MetaInlines") return renderInlines(title.c, limitations);
  if (title.t === "MetaBlocks") return renderBlocks(title.c, limitations);
  if (title.t === "MetaString" && typeof title.c === "string") return title.c;
  throw new WikiError("unsupported", `pandoc title node ${String(title.t)} is not extracted; refusing to drop or invent its text`);
}

/** Turn one Pandoc JSON document into searchable text. Raw HTML is omitted and named, never executed. */
export function renderPandocDocument(ast: unknown): { text: string; limitations: string[] } {
  if (!isObject(ast)) throw new WikiError("unsupported", "pandoc JSON is not an object; refusing to invent text");
  const limitations = new Set<string>();
  const text = joinBlocks([renderTitle(ast.meta, limitations), renderBlocks(ast.blocks, limitations)]);
  return { text, limitations: [...limitations] };
}

export async function extractHtml(html: string, signal: AbortSignal) {
  const info = await runTool("pandoc", ["--version"], Buffer.alloc(0), signal);
  let versionText: string;
  try { versionText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([info.stdout, Buffer.from("\n"), info.stderr])); }
  catch { throw new WikiError("unavailable", "pandoc did not report a usable version as UTF-8; check the program on PATH"); }
  const version = /^pandoc\s+(\S+)/m.exec(versionText)?.[1];
  if (info.code !== 0 || !version) throw new WikiError("unavailable", "pandoc did not report a usable version; check the program on PATH");
  const output = await runTool("pandoc", ["-f", "html-smart", "-t", "json", "--sandbox"], Buffer.from(html, "utf8"), signal);
  if (output.code !== 0) throw new WikiError("unsupported", "pandoc could not read the HTML; refusing to invent text: " + output.stderr.toString("utf8").trim());
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true }).decode(output.stdout); }
  catch { throw new WikiError("unsupported", "pandoc returned bytes that are not UTF-8; refusing to invent text"); }
  let ast: unknown;
  try { ast = JSON.parse(json); }
  catch { throw new WikiError("unsupported", "pandoc did not return JSON; refusing to invent text"); }
  const rendered = renderPandocDocument(ast);
  return { ...rendered,
    limitations: ["Static HTML text only; scripts and linked resources are not executed or fetched; visual layout and non-title metadata are not retained", ...rendered.limitations],
    bytes: Buffer.from(rendered.text, "utf8"), extractor: "pandoc", version };
}
