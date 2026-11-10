import { WikiError } from "./vault.ts";
import { runTool } from "./extract-process.ts";

// Adapted from the Pandoc text rendering of the former Node core package
// (removed in #41; see git history); no evidence or storage policy.
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

function inlineText(node: Record<string, unknown>): string {
  if (typeof node.c !== "string") throw new WikiError("unsupported", "pandoc Str node is not text; refusing to invent text");
  return node.c;
}

function inlineBreak(node: Record<string, unknown>): string {
  emptyNode(node);
  return node.t === "Space" ? " " : "\n";
}

function inlineCode(node: Record<string, unknown>): string {
  const content = tuple(node.c, 2);
  attributes(content[0]);
  const code = content[1];
  if (typeof code !== "string") throw new WikiError("unsupported", "pandoc Code node has an unexpected shape; refusing to invent text");
  return code;
}

function inlineChildren(node: Record<string, unknown>, limitations: Set<string>): string {
  // Formatting nodes store children directly on c.
  return renderInlines(node.c, limitations);
}

function attributedInlines(node: Record<string, unknown>, limitations: Set<string>): string {
  const hasTarget = ["Link", "Image"].includes(String(node.t));
  const content = tuple(node.c, hasTarget ? 3 : 2);
  if (node.t === "Quoted") {
    if (!isObject(content[0]) || !["SingleQuote", "DoubleQuote"].includes(String(content[0].t))) throw shapeError();
  } else attributes(content[0]);
  if (hasTarget) stringPair(content[2]);
  return renderInlines(content[1], limitations);
}

function rawInline(node: Record<string, unknown>, limitations: Set<string>): string {
  stringPair(node.c);
  limitations.add("omitted RawInline; raw HTML was not extracted or executed");
  return "";
}

const INLINE_RENDERERS = new Map<string, (node: Record<string, unknown>, limitations: Set<string>) => string>(Object.entries({
  Str: inlineText, Space: inlineBreak, SoftBreak: inlineBreak, LineBreak: inlineBreak,
  Code: inlineCode, Link: attributedInlines, Span: attributedInlines, Image: attributedInlines,
  Quoted: attributedInlines, RawInline: rawInline,
  Emph: inlineChildren, Strong: inlineChildren, Underline: inlineChildren, Strikeout: inlineChildren,
  Superscript: inlineChildren, Subscript: inlineChildren, SmallCaps: inlineChildren,
}));

function renderInlines(value: unknown, limitations: Set<string>): string {
  if (!Array.isArray(value)) throw new WikiError("unsupported", "pandoc AST inlines are not a list; refusing to invent text");
  let text = "";
  for (const node of value) {
    if (!isObject(node) || typeof node.t !== "string") {
      throw new WikiError("unsupported", "pandoc AST inline is not an object; refusing to invent text");
    }
    const renderer = INLINE_RENDERERS.get(node.t);
    if (!renderer) throw new WikiError("unsupported", `pandoc AST inline ${node.t} is not extracted; refusing to drop or invent its text`);
    text += renderer(node, limitations);
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

function renderHeader(body: unknown, limitations: Set<string>): string {
  const header = tuple(body, 3);
  if (!Number.isInteger(header[0])) throw shapeError();
  attributes(header[1]);
  return renderInlines(header[2], limitations);
}

function renderCodeBlock(body: unknown): string {
  const content = tuple(body, 2);
  attributes(content[0]);
  const code = content[1];
  if (typeof code !== "string") throw new WikiError("unsupported", "pandoc CodeBlock has an unexpected shape; refusing to invent text");
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

function renderDiv(body: unknown, limitations: Set<string>): string {
  const div = tuple(body, 2);
  attributes(div[0]);
  return renderBlocks(div[1], limitations);
}

function renderBulletList(body: unknown, limitations: Set<string>): string {
  return joinBlocks(asBlocks(body).map((item) => renderBlocks(item, limitations)));
}

function renderOrderedList(body: unknown, limitations: Set<string>): string {
  return renderBulletList(tuple(body, 2)[1], limitations);
}

function renderLineBlock(body: unknown, limitations: Set<string>): string {
  return joinBlocks(asBlocks(body).map((item) => renderInlines(item, limitations)));
}

function renderRule(body: unknown): string {
  emptyNode({ c: body });
  return "";
}

function renderRawBlock(body: unknown, limitations: Set<string>): string {
  stringPair(body);
  limitations.add("omitted RawBlock; raw HTML was not extracted or executed");
  return "";
}

const BLOCK_RENDERERS = new Map<string, (body: unknown, limitations: Set<string>) => string>(Object.entries({
  Para: renderInlines, Plain: renderInlines, Header: renderHeader, CodeBlock: renderCodeBlock,
  BlockQuote: renderBlocks, Div: renderDiv, BulletList: renderBulletList, OrderedList: renderOrderedList,
  LineBlock: renderLineBlock, Table: renderTable, Figure: renderFigure,
  HorizontalRule: renderRule, RawBlock: renderRawBlock,
}));

function renderBlock(block: unknown, limitations: Set<string>): string {
  if (!isObject(block) || typeof block.t !== "string") {
    throw new WikiError("unsupported", "pandoc AST block is not an object; refusing to invent text");
  }
  const renderer = BLOCK_RENDERERS.get(block.t);
  if (!renderer) throw new WikiError("unsupported", `pandoc AST block ${block.t} is not extracted; refusing to drop or invent its text`);
  return renderer(block.c, limitations);
}

function renderBlocks(value: unknown, limitations: Set<string>): string {
  return joinBlocks(asBlocks(value).map((block) => renderBlock(block, limitations)));
}

function renderTitleValue(title: Record<string, unknown>, limitations: Set<string>): string {
  if (title.t === "MetaInlines") return renderInlines(title.c, limitations);
  if (title.t === "MetaBlocks") return renderBlocks(title.c, limitations);
  if (title.t === "MetaString" && typeof title.c === "string") return title.c;
  throw new WikiError("unsupported", `pandoc title node ${String(title.t)} is not extracted; refusing to drop or invent its text`);
}

function renderTitle(meta: unknown, limitations: Set<string>): string {
  if (!isObject(meta)) throw new WikiError("unsupported", "pandoc metadata is not an object; refusing to invent text");
  if (meta.title === undefined) return "";
  if (!isObject(meta.title)) throw new WikiError("unsupported", "pandoc title is not an object; refusing to invent text");
  return renderTitleValue(meta.title, limitations);
}

/** Turn one Pandoc JSON document into searchable text. Raw HTML is omitted and named, never executed. */
export function renderPandocDocument(ast: unknown): { text: string; limitations: string[] } {
  if (!isObject(ast)) throw new WikiError("unsupported", "pandoc JSON is not an object; refusing to invent text");
  const limitations = new Set<string>();
  const text = joinBlocks([renderTitle(ast.meta, limitations), renderBlocks(ast.blocks, limitations)]);
  return { text, limitations: [...limitations] };
}

function pandocVersion(info: Awaited<ReturnType<typeof runTool>>): string {
  let versionText: string;
  try { versionText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([info.stdout, Buffer.from("\n"), info.stderr])); }
  catch { throw new WikiError("unavailable", "pandoc did not report a usable version as UTF-8; check the program on PATH"); }
  const version = /^pandoc\s+(\S+)/m.exec(versionText)?.[1];
  if (info.code !== 0 || !version) throw new WikiError("unavailable", "pandoc did not report a usable version; check the program on PATH");
  return version;
}

export async function extractHtml(html: string, signal: AbortSignal) {
  const info = await runTool("pandoc", ["--version"], Buffer.alloc(0), signal);
  const version = pandocVersion(info);
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
